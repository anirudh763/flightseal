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
deleted with the stack. Production uses `-c stage=prod`:

```sh
npx cdk deploy HashWingRegistry -c stage=prod \
  --parameters BudgetEmail=<you@example.com>
```

`stage=prod` turns on PITR with a 35-day recovery window, deletion protection on the table and the user pool, and
RETAIN on the table, user pool and log group. **A production deploy is not authorized yet**: the switch exists so
the settings are reviewed and tested, not as permission to deploy. Context is not remembered between runs, so
every later `cdk deploy` of a production stack (a rollback, a restore below) must repeat `-c stage=prod`; without
it the deploy turns protection off and sets the resources back to Delete.

The outputs are `ApiUrl`, `TableName`, `UserPoolId` and `UserPoolClientId`.

Demoting an admin: `custom:role` is read from the ID token as issued, so a demoted admin keeps admin rights until
that token expires (15 minutes; the app client sets ID and access tokens to 15 minutes). Always pair a demotion or
removal with `aws cognito-idp admin-user-global-sign-out --user-pool-id <pool> --username <user>`, which revokes
the refresh token so no new token with the old role can be obtained. Tokens already issued stay valid until they
expire; nothing in this design revokes them sooner.

Create users as an administrator; there is no self sign-up. `custom:org_id` (immutable) and `custom:role`
(`admin` or `pilot`) are set here, never by the app:

```sh
aws cognito-idp admin-create-user --user-pool-id <UserPoolId> --username <email> \
  --user-attributes Name=email,Value=<email> Name=custom:org_id,Value=<org> Name=custom:role,Value=admin
```

Clients sign in with SRP and send the **ID token** as `Authorization: Bearer <id token>`.

First steps for a company: an admin calls `GET /v1/keys/challenge`, signs the returned `message` with the
sealer's Ed25519 key, and posts `{public_key, nonce, signature}` to `POST /v1/keys`.

## When the budget alert fires

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
`stage=prod` stack uses `RemovalPolicy.RETAIN`: they stay after `cdk destroy` and keep billing (storage and PITR)
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
   the stack does not manage it.
2. Pick a new random restore ID (for example `uuidgen`). Point the function at the new table and close every route
   until tombstones are applied:

   ```sh
   cd infra && npx cdk deploy HashWingRegistry -c restoredTableName=<new table> -c restoredFrom=<served table> \
     -c restoreId=<restore id>
   ```

   This sets `TABLE_NAME`, `RESTORED_FROM` and `RESTORE_ID`, and moves the function's IAM grant to the new table's
   ARN. The function now answers 503 `restore_pending` everywhere. A marker copied in from the backup does not open
   it: the marker must name this table and this restore ID.
3. With credentials that can scan the source and write the target:

   ```sh
   cd registry
   python -m registry.restore --source <served table> --served <served table> --target <new table> \
     --restore-id <restore id>
   ```

   It copies every tombstone (withdrawals, deletions, key rotations and compromises, epoch bumps), re-applies it,
   recomputes each org's active key, and writes `SYSTEM/RESTORE` (source, target, restore ID) last. If it fails (for example the source
   cannot be read), no marker is written and the function stays closed. Fix the cause and run it again; it is safe
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
