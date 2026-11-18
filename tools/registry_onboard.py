#!/usr/bin/env python3
"""Operator script: add a person to a company in the registry's Cognito user pool (R28, R71, AD-4).

  python3 tools/registry_onboard.py invite --pool-id <UserPoolId> --org <org> --email <email>
      [--role admin --first-admin | --role admin --confirm-additional-admin] [--dry-run]

The first admin of a company and every later pilot are both created here. The role is `pilot` unless the operator
types `--role admin` plus one acknowledgement: --first-admin, or --confirm-additional-admin (the script cannot see
whether the company already has an admin). The email is lowercased, so case variants are one user. The org must be
listed in the production allow-list given with --orgs (absent or empty: everything is refused), so a typo cannot create
a new company. That list holds real customers, so it lives outside this public repository: a list inside the repo
(such as the demo fixture tools/registry_orgs.demo.json) is accepted only with --dry-run. The invitee chooses nothing: org and role are admin-only attributes the app client
cannot write. Cognito makes the temporary password and emails it; this script never sees or prints one, and an
invitation never carries a company private key. An existing user is refused and left unchanged.

Run by the owner with their own AWS credentials. --dry-run prints the exact AdminCreateUser request and calls
nothing. boto3 is imported only for a real run.
"""
import argparse
import difflib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "registry"))
from registry.identity import ORG_ID, ROLES  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
DEMO_ORGS = REPO / "tools" / "registry_orgs.demo.json"  # demo fixture: example ids only, never onboarded
POOL_ID = re.compile(r"([a-z]{2}(?:-[a-z]+)+-\d)_[0-9A-Za-z]{1,32}")
EMAIL = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
DEFAULT_MAX_TEMP_DAYS = 7  # upper bound only; the pool's own setting is set by the infra stack (infra/lib/stack.ts: 3 days)


class Refused(Exception):
    pass


def load_orgs(path):
    try:
        data = json.loads(Path(path).read_text())
    except FileNotFoundError:
        raise Refused(f"no allow-list at {path}: add the company's org id there first") from None
    except ValueError:
        raise Refused(f"{path} is not valid JSON") from None
    orgs = data.get("orgs") if isinstance(data, dict) else None
    if not isinstance(orgs, list) or not all(isinstance(o, str) and ORG_ID.fullmatch(o) for o in orgs):
        raise Refused(f'{path} must be {{"orgs": [...]}} with ids of 1-64 letters, digits, "_" or "-"')
    return set(orgs)


def create_request(pool_id, email, org, role):
    return {
        "UserPoolId": pool_id,
        "Username": email,
        "UserAttributes": [{"Name": "email", "Value": email}, {"Name": "custom:org_id", "Value": org},
                           {"Name": "custom:role", "Value": role}],
        "DesiredDeliveryMediums": ["EMAIL"],
    }


def check_pool(client, pool_id, max_days):
    pool = client.describe_user_pool(UserPoolId=pool_id)["UserPool"]
    if not (pool.get("AdminCreateUserConfig") or {}).get("AllowAdminCreateUserOnly"):
        raise Refused("the user pool allows self sign-up; refusing to add users to it")
    days = ((pool.get("Policies") or {}).get("PasswordPolicy") or {}).get("TemporaryPasswordValidityDays")
    if not isinstance(days, int) or not 1 <= days <= max_days:
        raise Refused(f"the pool's TemporaryPasswordValidityDays is {days}, expected 1 to {max_days}")
    return days


def error_code(err):
    return ((getattr(err, "response", None) or {}).get("Error") or {}).get("Code")


def invite(args, client, orgs_path):
    if not POOL_ID.fullmatch(args.pool_id):
        raise Refused("--pool-id does not look like a Cognito user pool id (e.g. us-east-1_AbC123)")
    if len(args.email) > 254 or not EMAIL.fullmatch(args.email):
        raise Refused("--email is not an email address")
    args.email = args.email.lower()  # one person, one user: case variants must not become two users with two roles
    if args.role == "admin" and not (args.first_admin or args.confirm_additional_admin):
        raise Refused("an admin needs --first-admin (the company's first) or --confirm-additional-admin "
                      "(this script cannot check whether the company already has one)")
    if args.role != "admin" and (args.first_admin or args.confirm_additional_admin):
        raise Refused("--first-admin and --confirm-additional-admin are only for --role admin")
    if not orgs_path:
        raise Refused("give the production allow-list with --orgs <path outside this repository>")
    if Path(orgs_path).resolve().is_relative_to(REPO) and not args.dry_run:
        raise Refused(f"{orgs_path} is inside the public repository, so it is demo-only and allowed with --dry-run; "
                      "keep the production allow-list outside the repository")
    orgs = load_orgs(orgs_path)
    if args.org not in orgs:
        near = difflib.get_close_matches(args.org, sorted(orgs), n=1)
        raise Refused(f"org {args.org!r} is not in the allow-list" + (f"; did you mean {near[0]!r}?" if near else ""))
    request = create_request(args.pool_id, args.email, args.org, args.role)
    if args.dry_run:
        print(json.dumps({"operation": "AdminCreateUser", "request": request}, indent=2))
        return 0
    if client is None:
        import boto3  # only for a real run
        client = boto3.client("cognito-idp", region_name=POOL_ID.fullmatch(args.pool_id).group(1))
    days = check_pool(client, args.pool_id, args.max_temp_days)
    try:
        client.admin_create_user(**request)
    except Exception as err:
        if error_code(err) == "UsernameExistsException":
            print(f"{args.email} already exists; nothing changed. A role change is a separate admin step "
                  "(see docs/aws/RUNBOOK_AWS.md).", file=sys.stderr)
            return 1
        raise
    print(f"Invited {args.email} to {args.org} as {args.role}. Cognito emails a temporary password, "
          f"valid {days} days.")
    return 0


def main(argv=None, client=None, orgs_path=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    inv = sub.add_parser("invite", help="create a company's first admin (--role admin) or invite a pilot")
    inv.add_argument("--pool-id", required=True)
    inv.add_argument("--org", required=True, help="an org id listed in the --orgs allow-list")
    inv.add_argument("--orgs", help="production allow-list JSON, kept outside this repository")
    inv.add_argument("--email", required=True)
    inv.add_argument("--role", choices=ROLES, default="pilot", help="default pilot; type admin explicitly")
    ack = inv.add_mutually_exclusive_group()
    ack.add_argument("--first-admin", action="store_true", help="with --role admin: the company's first admin")
    ack.add_argument("--confirm-additional-admin", action="store_true",
                     help="with --role admin: you know the company may already have an admin")
    inv.add_argument("--max-temp-days", type=int, default=DEFAULT_MAX_TEMP_DAYS,
                     help="refuse if the pool's TemporaryPasswordValidityDays is above this")
    inv.add_argument("--dry-run", action="store_true", help="print the AdminCreateUser request; call nothing")
    args = parser.parse_args(argv)
    try:
        return invite(args, client, orgs_path or args.orgs)
    except Refused as err:
        print(f"refused: {err}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
