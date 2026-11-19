# Registry runbook

Nothing in this repository deploys to AWS: CI only synthesises. Everything below is for an owner who has decided
to deploy, with their own credentials, in us-east-1. None of it has been run against real AWS.

## Deploy

```sh
cd infra
npm ci
npm test                                      # synth + assertions, no credentials needed
npx cdk bootstrap aws://<account>/us-east-1   # once per account and region
npx cdk deploy HashWingRegistry \
  --parameters BudgetEmail=<you@example.com>  # optional: omit to create no budget
  # add -c pitr=true to turn on point-in-time recovery (billed per GB-month)
```

That deploys the disposable `dev` stage: PITR off unless `-c pitr=true`, and the table, user pool and log group are
deleted with the stack.

**A production deploy is not authorized yet.** The production switch exists so its settings are reviewed and
tested, not as permission to deploy. When it is authorized, production is a separate stack, `HashWingRegistry-prod`:

```sh
npx cdk deploy HashWingRegistry-prod -c stage=prod \
  --parameters BudgetEmail=<you@example.com>
```

`stage=prod` turns on PITR with a 35-day recovery window, deletion protection on the table and the user pool, and
RETAIN on the table, user pool and log group. Production reads its restore settings only from the committed
`infra/restore.json` (`{}` = never restored); synth fails if that file is missing or malformed.

The app only defines `HashWingRegistry-prod` when `-c stage=prod` is given. A deploy without it, or with a
misspelt key such as `-c Stage=prod`, builds the dev stack `HashWingRegistry` and cannot update the production
stack; naming `HashWingRegistry-prod` without the flag fails with "no stacks match". If production were ever
deployed with dev settings, it would turn PITR off (losing the 35-day recovery history), drop deletion protection,
set the resources to Delete and point the function back at the original table, undoing a restore. Every command
below that touches production must therefore use `HashWingRegistry-prod -c stage=prod`.

The outputs are `ApiUrl`, `TableName`, `UserPoolId` and `UserPoolClientId`.

Demoting an admin: `custom:role` is read from the ID token as issued, so a demoted admin keeps admin rights until
that token expires (15 minutes; the app client sets ID and access tokens to 15 minutes). Always pair a demotion or
removal with `aws cognito-idp admin-user-global-sign-out --user-pool-id <pool> --username <user>`, which revokes
the refresh token so no new token with the old role can be obtained. Tokens already issued stay valid until they
expire; nothing in this design revokes them sooner.

The Lambda's cognito adapter also needs `COGNITO_ISSUER` (`https://cognito-idp.us-east-1.amazonaws.com/<UserPoolId>`)
and `COGNITO_CLIENT_ID` (`<UserPoolClientId>`). Without both, every signed-in request is 503
`identity_unavailable` and the log says `identity config`. The stack sets both from its own user pool and app client
(`infra/lib/stack.ts`), with a synth assertion. A bad or wrong token is 401.

## Onboard a company

There is no self sign-up. `custom:org_id` (immutable) and `custom:role` (`admin` or `pilot`) are set by an
operator with `tools/registry_onboard.py`, never by the app or the invitee. Not yet run against real Cognito.

1. Add the company's org id (1 to 64 letters, digits, `_` or `-`) to the production allow-list, a JSON file
   `{"orgs": [...]}` that you keep **outside this public repository** (with the owner's other private config), and pass
   it with `--orgs <path>`. The script refuses any org not listed there, names the closest listed id when it looks like
   a typo, and refuses a list inside the repository except with `--dry-run`. `tools/registry_orgs.demo.json` holds
   example ids only (`example-company-a`, `example-company-b`) for dry runs and demos; never add a customer to it.
2. Check the request, then create the first admin. `--role admin` must be typed together with `--first-admin`;
   without `--role` the role is `pilot`:

   ```sh
   python3 tools/registry_onboard.py invite --pool-id <UserPoolId> --orgs <path> --org <org> --email <email> --role admin --first-admin --dry-run
   python3 tools/registry_onboard.py invite --pool-id <UserPoolId> --orgs <path> --org <org> --email <email> --role admin --first-admin
   ```

   A later admin uses `--confirm-additional-admin` instead. The script cannot see whether the company already has
   an admin; the flag is the operator's acknowledgement.
3. Invite each pilot the same way without `--role`.

Before creating anyone the script checks that the pool allows admin-created users only and that its
`TemporaryPasswordValidityDays` is between 1 and 7 (change the limit with `--max-temp-days`). The pool setting
itself is set by the infra stack (`infra/lib/stack.ts`: 3 days). Cognito makes the temporary password and emails it;
the script never sees or prints one. The email is lowercased, so `A@x.com` and `a@x.com` are one user. A user
who already exists is refused and left unchanged. The script needs `boto3` and the owner's
credentials only for a real run; `--dry-run` calls nothing.

Clients sign in with SRP and send the **ID token** as `Authorization: Bearer <id token>`. The registry accepts only
an ID token (`token_use` `id`) issued by this pool for this app client; an access token is 401. After the first
admin signs in, check both (never run yet): `GET /v1/keys` with their ID token is 200, with their access token 401.

### How pilots sign

Option A, decided by the owner on 2026-11-18 (design PR #57, spine AD-4), is the default. Option B (a pilot's own
key, authorized by the company key) has its server half built and is off everywhere; see "Pilot keys (Option B)"
below.

- A company has one signing computer and one active key. An admin enrolls that key from the signing computer
  (the steps below). Its private key never leaves that computer.
- An invitation only creates a sign-in. It never carries a company private key, and every registry POST route
  refuses a private-key field (`test_no_route_accepts_private_key_material`).
- A pilot without the signing computer either hands the files to the signing computer to seal there, or seals with
  a one-time key. A one-time key is not the company's: the registry refuses its receipts (`key_not_enrolled`) and
  the person checking the file is told the signature is valid but the key is not in their trusted list, so the
  signer is not confirmed.

First steps for a company: an admin calls `GET /v1/keys/challenge`. The client builds the bytes
`hashwing-key-enroll v1\n<org>\n<nonce>` itself and signs them with the sealer's Ed25519 key only if the server's
`message` is byte-equal to them (`registry/registry/enroll_challenge.py`); otherwise it signs nothing. It then posts
`{public_key, nonce, signature}` to `POST /v1/keys`.

### Pilot keys (Option B)

Server half only: the browser screens (Trust pilot UI, Verify delegated path) are not built, so nothing on the
recipient side honours an authorization yet. **Do not switch an org on without the owner's explicit yes** (design
"Defaults taken 2026-11-19" #1): a stolen or retired pilot key can still read "Verified" to recipients until its
authorization ends (at most 30 days, 14 by default), and an honest pilot-signed proof drops to "signer not
confirmed" once it ends.

- **Switch on:** set `PILOT_KEYS_ORGS` on the Lambda to a comma list of exact org ids (for example `orgA,orgB`; no
  spaces, no `*`; an entry that isn't exactly an org id is ignored). The stack never sets it, so this is a manual
  change on the function's environment, and a later `cdk deploy` removes it again. The dev server takes
  `--pilot-keys-orgs orgA` (local only).
- **Switch off:** remove the org from the list (or the whole variable). The pilot routes answer `pilot_keys_off`,
  pilot keys get `key_not_active` on register, and every stored pilot key, tombstone and `PILOT_COUNT` is kept, so
  switching back on restores them as they were.
- **Enroll:** the pilot makes a key on their own device, the company computer signs an authorization for its public
  key (confirm the full fingerprint with the pilot by phone or in person first), then the pilot calls
  `GET /v1/pilot-keys/challenge` and `POST /v1/pilot-keys`. The authorization must be signed by the org's current
  active company key.
- **Renewal** is a new pilot key and a new authorization. An authorization is never extended and a fingerprint is
  never enrolled twice.
- **Expired pilot keys stay `active`** in `GET /v1/keys` and still count toward the 50-key cap until an admin
  retires them (`POST /v1/pilot-keys/<fp>/retire`); they cannot register. Retire the keys of pilots who leave.
- **Company key replaced or compromised:** pilot keys under the old key stop registering (their parent isn't
  active). Nothing is rewritten; retire them to free their slots, then authorize new keys under the new company key.

## When the budget alert fires

Decided 2026-11-17, not built (spine AD-18): the budget response will be a reversible traffic pause that keeps the table and user pool. Neither step below is that response: deleting the stage is untested and may not come back with `cdk deploy`, and destroying deletes the data. Until the pause exists, they are the only options, and the infra packet replaces them:

The budget email only warns. Nothing stops requests or spend until you act. Pick one:

1. **Stop all traffic now, keep the data.** Delete the `$default` stage. The API then answers nothing and nothing
   reaches the Lambda:

   ```sh
   aws apigatewayv2 delete-stage --api-id <ApiId> --stage-name '$default'
   ```

   CloudFormation does not notice a stage deleted this way, so a plain `npx cdk deploy` may not bring it back.
   This has not been tested. The one way back known to work is to destroy and deploy again, which also deletes the
   table.
2. **Remove everything:** follow "Destroy" below with `npx cdk destroy HashWingRegistry`. The table and the user
   pool are deleted with the stack (dev stage only; a `stage=prod` stack keeps them, see "Destroy").

Then check Cost Explorer for which line grew: API Gateway requests, Lambda, DynamoDB or logs (see the abuse
scenario in [COST.md](COST.md)). Do not add a WAF: it has a fixed monthly fee.

## Destroy and check that nothing remains

```sh
cd infra && npx cdk destroy HashWingRegistry
```

In the dev stage the table, log group and user pool use `RemovalPolicy.DESTROY`, so they go with the stack. A
production stack (`HashWingRegistry-prod`) uses `RemovalPolicy.RETAIN`: they stay after `cdk destroy` and keep billing (storage and PITR)
until deleted by hand, and the table and user pool need deletion protection turned off first. Then check, in us-east-1:

```sh
aws cloudformation describe-stacks --stack-name HashWingRegistry          # expect: does not exist
aws dynamodb list-tables                                                   # no HashWingRegistry-Table*
aws dynamodb list-backups                                                  # on-demand backups are not deleted by the stack
aws lambda list-functions --query "Functions[].FunctionName"               # no HashWingRegistry-Function*
aws apigatewayv2 get-apis --query "Items[].Name"                           # no HashWingRegistry Api
aws cognito-idp list-user-pools --max-results 60 --query "UserPools[].Name"
aws logs describe-log-groups --log-group-name-prefix HashWingRegistry
aws logs describe-log-groups --log-group-name-prefix /aws/lambda/HashWingRegistry
aws budgets describe-budgets --account-id <account>                        # if BudgetEmail was set
aws s3 ls | grep cdk-                                                      # the bootstrap bucket stays until you remove the CDKToolkit stack
```

The CDK bootstrap stack (`CDKToolkit`, its S3 bucket and ECR repository) is not part of this stack; delete it
separately if nothing else uses it.

## Roll back

- Code only: redeploy the previous commit (`git checkout <sha> && cd infra && npx cdk deploy`). The table schema
  has no migrations, so rolling the function back is safe.
- A deploy that failed half-way: CloudFormation rolls back by itself. If it is stuck in `UPDATE_ROLLBACK_FAILED`,
  use `aws cloudformation continue-update-rollback --stack-name HashWingRegistry`.
- Never roll back by restoring the table from a backup without the restore procedure below: that would bring back
  withdrawn shares.

## Restore from a backup

A restore always creates a new table. The steps keep withdrawn shares and deleted registrations gone.

The **source** is always the table the function serves right now, read from its configuration:
`aws lambda get-function-configuration --function-name <function> --query Environment.Variables.TABLE_NAME`.
After a first restore that is the restored table, not the stack's own table: tombstones written since then exist
only there. A source that is not the served table is refused, because its tombstones may be stale.

1. Restore (PITR or an on-demand backup) to a new table, for example `HashWingRegistry-restored-2`.
   After a restore, set PITR (35 days), deletion protection and TTL on the restored table before opening the gate;
   the stack does not manage it. For the same reason the restored table outlives `cdk destroy` and keeps billing
   (storage, and PITR once on) until deleted by hand, with deletion protection turned off first.
2. Pick a new random restore ID (for example `uuidgen`). Point the function at the new table and close every route
   until tombstones are applied:

   ```sh
   cd infra && npx cdk deploy HashWingRegistry -c restoredTableName=<new table> -c restoredFrom=<served table> \
     -c restoreId=<restore id>
   ```

   That is the dev form. For production (**not authorized yet**) the `-c` restore flags are refused: replace the
   `{}` in `infra/restore.json` with all three values (`{"restoredTableName": "<new table>", "restoredFrom":
   "<served table>", "restoreId": "<restore id>"}`, non-empty, and `restoredFrom` must differ from the new table),
   commit it, and run `npx cdk deploy HashWingRegistry-prod -c stage=prod`. Keep the file committed: every later
   production deploy reads it, so a routine deploy cannot point the function back at the old table. A dev synth
   refuses a file that records a restore.

   This sets `TABLE_NAME`, `RESTORED_FROM` and `RESTORE_ID`, and moves the function's IAM grant to the new table's
   ARN. The function now answers 503 `restore_pending` everywhere. A marker copied in from the backup does not open
   it: the marker must name this table and this restore ID.
3. With credentials that can scan the source and write the target:

   ```sh
   cd registry
   python -m registry.restore --source <served table> --served <served table> --target <new table> \
     --restore-id <restore id>
   ```

   It copies every tombstone (withdrawals, deletions, key rotations, retirements and compromises, epoch bumps),
   re-applies it (the most revoked key state wins), recomputes each org's active company key and its active pilot
   key count (pilot keys keep their state, kind, parent and `not_after`), and writes `SYSTEM/RESTORE` (source, target, restore ID) last. If it fails (for example the source
   cannot be read, or a tombstone and its key disagree on whether the key is a pilot key), no marker is written and the function stays closed. Fix the cause and run it again; it is safe
   to repeat.
4. Check: a share you know was withdrawn returns 404; an active one returns 200.
5. If the source table no longer exists, its tombstones are gone. Keep the function closed and decide by hand:
   the safe default is to withdraw every share in the restored table.

## LocalStack (local only)

Community image, REST API v1 stand-in, dev tokens:

```sh
uv run --no-project --with boto3==1.43.123 python registry/localstack/e2e.py
```

It needs Docker and binds `127.0.0.1:4599` only. It uses the test credentials `test`/`test`, empty AWS config
files and an explicit endpoint, generates a fresh dev secret each run, writes
`docs/aws/evidence/localstack-4.12.0.json` and removes the container and the `hashwing-localstack` volume at the
end. The exit status is 1 whenever any step failed, including the persistence checks that are expected to fail on
the community image.

The real stack (HTTP API + Cognito) needs LocalStack Pro:

```sh
LOCALSTACK_AUTH_TOKEN=... registry/localstack/deploy_cdklocal.sh
```

Without the token it exits 2 and starts nothing. It has not been run for this repository.
