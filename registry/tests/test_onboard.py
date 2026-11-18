"""tools/registry_onboard.py (R28, R71) with a fake Cognito client: nothing here calls AWS."""
import importlib.util
import json
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "tools" / "registry_onboard.py"
spec = importlib.util.spec_from_file_location("onboard", SCRIPT)  # by path: tools/ is not a package
onboard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(onboard)

POOL = "us-east-1_TestPool1"


class Exists(Exception):
    response = {"Error": {"Code": "UsernameExistsException", "Message": "User account already exists"}}


class FakeCognito:
    def __init__(self, temp_days=7, admin_only=True, existing=()):
        self.calls, self.users = [], {u: {} for u in existing}
        self.pool = {"UserPool": {"Policies": {"PasswordPolicy": {"TemporaryPasswordValidityDays": temp_days}},
                                  "AdminCreateUserConfig": {"AllowAdminCreateUserOnly": admin_only}}}

    def describe_user_pool(self, **kw):
        self.calls.append(("describe_user_pool", kw))
        return self.pool

    def admin_create_user(self, **kw):
        self.calls.append(("admin_create_user", kw))
        if kw["Username"] in self.users:
            raise Exists()
        self.users[kw["Username"]] = kw
        return {"User": {"Username": kw["Username"], "UserStatus": "FORCE_CHANGE_PASSWORD"}}


@pytest.fixture
def orgs(tmp_path):
    path = tmp_path / "orgs.json"
    path.write_text(json.dumps({"orgs": ["acme-air", "skyworks"]}))
    return path


def run(orgs, *args, client=None):
    return onboard.main(["invite", "--pool-id", POOL, *args], client=client, orgs_path=orgs)


def created(fake):
    return [kw for name, kw in fake.calls if name == "admin_create_user"]


def attrs(kw):
    return {a["Name"]: a["Value"] for a in kw["UserAttributes"]}


def test_default_role_is_pilot(orgs, capsys):
    fake = FakeCognito()
    assert run(orgs, "--org", "acme-air", "--email", "p@acme.example", client=fake) == 0
    [kw] = created(fake)
    assert kw["UserPoolId"] == POOL and kw["Username"] == "p@acme.example"
    assert attrs(kw) == {"email": "p@acme.example", "custom:org_id": "acme-air", "custom:role": "pilot"}
    assert "TemporaryPassword" not in kw and kw["DesiredDeliveryMediums"] == ["EMAIL"]
    assert "pilot" in capsys.readouterr().out


def test_admin_needs_explicit_role_flag(orgs):
    fake = FakeCognito()
    assert run(orgs, "--org", "acme-air", "--email", "a@acme.example", "--role", "admin", "--first-admin",
               client=fake) == 0
    assert attrs(created(fake)[0])["custom:role"] == "admin"
    for bad in ("Admin", "owner", "superadmin", ""):
        with pytest.raises(SystemExit):
            run(orgs, "--org", "acme-air", "--email", "x@acme.example", "--role", bad, client=FakeCognito())


def test_admin_needs_first_or_additional_acknowledgement(orgs, capsys):
    fake = FakeCognito()
    assert run(orgs, "--org", "acme-air", "--email", "a@acme.example", "--role", "admin", client=fake) == 2
    assert fake.calls == [] and "--first-admin" in capsys.readouterr().err
    assert run(orgs, "--org", "acme-air", "--email", "b@acme.example", "--role", "admin",
               "--confirm-additional-admin", client=fake) == 0
    assert attrs(created(fake)[0])["custom:role"] == "admin"
    with pytest.raises(SystemExit):  # one acknowledgement, not both
        run(orgs, "--org", "acme-air", "--email", "c@acme.example", "--role", "admin", "--first-admin",
            "--confirm-additional-admin", client=FakeCognito())
    for flag in ("--first-admin", "--confirm-additional-admin"):  # meaningless for a pilot: refused, not ignored
        fake = FakeCognito()
        assert run(orgs, "--org", "acme-air", "--email", "p@acme.example", flag, client=fake) == 2
        assert fake.calls == []


def test_email_is_lowercased_so_case_variants_are_one_user(orgs):
    fake = FakeCognito()
    assert run(orgs, "--org", "acme-air", "--email", "Pilot@Acme.Example", client=fake) == 0
    kw = created(fake)[0]
    assert kw["Username"] == "pilot@acme.example" and attrs(kw)["email"] == "pilot@acme.example"
    assert run(orgs, "--org", "acme-air", "--email", "PILOT@acme.example", "--role", "admin",
               "--confirm-additional-admin", client=fake) == 1  # same user: refused, still a pilot
    assert attrs(fake.users["pilot@acme.example"])["custom:role"] == "pilot"


def test_unknown_or_typod_org_is_refused(orgs, capsys):
    for org in ("unknown-co", "acme-iar", "ACME-AIR", "acme-air ", "acme#air"):
        fake = FakeCognito()
        assert run(orgs, "--org", org, "--email", "p@acme.example", client=fake) == 2
        assert fake.calls == []
    assert "acme-air" in capsys.readouterr().err  # the near miss is named so the operator can fix the typo


def test_missing_or_bad_allow_list_is_refused(tmp_path, orgs):
    fake = FakeCognito()
    assert run(tmp_path / "absent.json", "--org", "acme-air", "--email", "p@acme.example", client=fake) == 2
    bad = tmp_path / "bad.json"
    for text in ("[]", "{", json.dumps({"orgs": ["ok", "has#hash"]}), json.dumps({"orgs": "acme-air"})):
        bad.write_text(text)
        assert run(bad, "--org", "ok", "--email", "p@acme.example", client=fake) == 2
    assert fake.calls == []


def test_existing_user_is_refused_and_not_changed(orgs, capsys):
    fake = FakeCognito(existing=["p@acme.example"])
    assert run(orgs, "--org", "skyworks", "--email", "p@acme.example", client=fake) == 1
    assert [n for n, _ in fake.calls] == ["describe_user_pool", "admin_create_user"]  # no update, no resend
    assert fake.users["p@acme.example"] == {}
    assert "already exists" in capsys.readouterr().err


def test_temporary_password_validity_must_be_within_limit(orgs, capsys):
    for days in (8, 30, None):
        fake = FakeCognito(temp_days=days)
        assert run(orgs, "--org", "acme-air", "--email", "p@acme.example", client=fake) == 2
        assert created(fake) == []
    fake = FakeCognito(temp_days=3)
    assert run(orgs, "--org", "acme-air", "--email", "p@acme.example", "--max-temp-days", "2", client=fake) == 2
    assert run(orgs, "--org", "acme-air", "--email", "p@acme.example", "--max-temp-days", "3", client=fake) == 0
    assert "3 days" in capsys.readouterr().out


def test_self_sign_up_pool_is_refused(orgs):
    fake = FakeCognito(admin_only=False)
    assert run(orgs, "--org", "acme-air", "--email", "p@acme.example", client=fake) == 2
    assert created(fake) == []


def test_bad_email_or_pool_is_refused(orgs):
    for email in ("not-an-email", "a@b", "a b@c.example", "x" * 250 + "@c.example"):
        fake = FakeCognito()
        assert run(orgs, "--org", "acme-air", "--email", email, client=fake) == 2 and fake.calls == []
    fake = FakeCognito()
    assert onboard.main(["invite", "--pool-id", "nope", "--org", "acme-air", "--email", "p@acme.example"],
                        client=fake, orgs_path=orgs) == 2 and fake.calls == []


def test_dry_run_prints_the_exact_request_and_calls_nothing(orgs, capsys):
    fake = FakeCognito()
    assert run(orgs, "--org", "acme-air", "--email", "p@acme.example", "--dry-run", client=fake) == 0
    assert fake.calls == []
    out = json.loads(capsys.readouterr().out)
    assert out["operation"] == "AdminCreateUser"
    assert out["request"] == onboard.create_request(POOL, "p@acme.example", "acme-air", "pilot")
    real = FakeCognito()
    run(orgs, "--org", "acme-air", "--email", "p@acme.example", client=real)
    assert created(real)[0] == out["request"]


def test_output_never_contains_a_password(orgs, capsys):
    fake = FakeCognito()
    fake.admin_create_user = lambda **kw: {"User": {"Username": kw["Username"]}, "TemporaryPassword": "S3cret!x"}
    assert run(orgs, "--org", "acme-air", "--email", "p@acme.example", client=fake) == 0
    out = capsys.readouterr()
    assert "S3cret" not in out.out + out.err


def test_committed_allow_list_is_valid():
    assert isinstance(onboard.load_orgs(onboard.ORGS), set)  # the owner adds real orgs; it must stay loadable
