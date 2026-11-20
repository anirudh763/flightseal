import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { RegistryStack, restoreSettings, stackId } from '../lib/stack';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

// Synth with no credentials: an environment-agnostic stack performs no lookups.
for (const v of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE']) delete process.env[v];
process.env.AWS_CONFIG_FILE = '/dev/null';
process.env.AWS_SHARED_CREDENTIALS_FILE = '/dev/null';

function synth(pitr?: boolean): Template {
  return Template.fromStack(new RegistryStack(new App(), 'Test', { pitr }));
}

const t = synth();
const json = t.toJSON();

function resources(type: string): Array<[string, any]> {
  return Object.entries(json.Resources as Record<string, any>).filter(([, r]) => r.Type === type);
}

function fnByHandler(handler: string): any {
  const found = resources('AWS::Lambda::Function').filter(([, r]) => r.Properties.Handler === handler);
  assert.equal(found.length, 1, handler);
  return found[0];
}

test('Lambda: python3.12, arm64, 128 MB, 5 s, cognito adapter, no DEV_ variables', () => {
  t.resourceCountIs('AWS::Lambda::Function', 2); // the request function and the R52 scrub
  t.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'python3.12',
    Architectures: ['arm64'],
    MemorySize: 128,
    Timeout: 5,
    Handler: 'handler.handler',
    Environment: { Variables: { IDENTITY_ADAPTER: 'cognito', TABLE_NAME: Match.anyValue() } },
  });
  const [, fn] = fnByHandler('handler.handler');
  assert.deepEqual(Object.keys(fn.Properties.Environment.Variables).sort(),
    ['COGNITO_CLIENT_ID', 'COGNITO_ISSUER', 'IDENTITY_ADAPTER', 'TABLE_NAME']);
  assert.ok(!JSON.stringify(json).includes('DEV_'), 'no DEV_ setting anywhere in the template');
  for (const stage of [json, Template.fromStack(new RegistryStack(new App(), 'ProdPilot', { stage: 'prod' })).toJSON()]) {
    assert.ok(!JSON.stringify(stage).includes('PILOT_KEYS_ORGS'), 'Option B pilot keys stay off: the stack never sets the switch');
  }
});

test('Lambda gets COGNITO_ISSUER and COGNITO_CLIENT_ID from the stack\'s own user pool and client, in both stages', () => {
  const [[poolId]] = resources('AWS::Cognito::UserPool');
  const [[clientId]] = resources('AWS::Cognito::UserPoolClient');
  const expected = {
    COGNITO_ISSUER: { 'Fn::Join': ['', ['https://cognito-idp.', { Ref: 'AWS::Region' }, '.amazonaws.com/', { Ref: poolId }]] },
    COGNITO_CLIENT_ID: { Ref: clientId },
  };
  t.hasResourceProperties('AWS::Lambda::Function', { Environment: { Variables: expected } });
  Template.fromStack(new RegistryStack(new App(), 'ProdEnv', { stage: 'prod' }))
    .hasResourceProperties('AWS::Lambda::Function', { Environment: { Variables: expected } });
});

test('explicit log group with 7-day retention, no LogRetention custom resource', () => {
  t.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
  assert.equal(resources('Custom::LogRetention').length, 0);
  t.hasResourceProperties('AWS::Lambda::Function', { LoggingConfig: { LogGroup: Match.anyValue() } });
});

test('DynamoDB: on demand, ttl, PITR off by default and on by context, destroyed with the stack', () => {
  t.hasResource('AWS::DynamoDB::Table', {
    Properties: {
      BillingMode: 'PAY_PER_REQUEST',
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false },
    },
    DeletionPolicy: 'Delete',
  });
  synth(true).hasResourceProperties('AWS::DynamoDB::Table', {
    PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
  });
});

test('prod keeps the data: PITR 35 days, deletion protection, Retain on table, user pool and log group', () => {
  // pitr: false is what cdk.json passes; prod must override it.
  const p = Template.fromStack(new RegistryStack(new App(), 'Prod', { stage: 'prod', pitr: false }));
  const keep = { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' };
  p.hasResource('AWS::DynamoDB::Table', {
    ...keep,
    Properties: {
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: 35 },
      DeletionProtectionEnabled: true,
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
    },
  });
  p.hasResource('AWS::Cognito::UserPool', { ...keep, Properties: { DeletionProtection: 'ACTIVE' } });
  p.hasResource('AWS::Logs::LogGroup', { ...keep, Properties: { RetentionInDays: 7 } });
});

test('dev (the default) stays disposable: no PITR window, no deletion protection, Delete policies', () => {
  const dev = Template.fromStack(new RegistryStack(new App(), 'Test', { stage: 'dev' }));
  assert.deepEqual(dev.toJSON(), json, 'stage dev synthesizes the same template as no stage');
  const gone = { DeletionPolicy: 'Delete', UpdateReplacePolicy: 'Delete' };
  dev.hasResource('AWS::DynamoDB::Table', {
    ...gone,
    Properties: {
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false, RecoveryPeriodInDays: Match.absent() },
      DeletionProtectionEnabled: Match.absent(),
    },
  });
  dev.hasResource('AWS::Cognito::UserPool', { ...gone, Properties: { DeletionProtection: Match.absent() } });
  dev.hasResource('AWS::Logs::LogGroup', gone);
  assert.throws(() => new RegistryStack(new App(), 'Bad', { stage: 'production' as any }), /not 'dev' or 'prod'/);
});

/** The policy statements attached to the role of the function with this handler. */
function statementsFor(handler: string): any[] {
  const [, fn] = fnByHandler(handler);
  const role = fn.Properties.Role['Fn::GetAtt'][0];
  const policies = resources('AWS::IAM::Policy').filter(([, p]) => p.Properties.Roles.some((r: any) => r.Ref === role));
  assert.equal(policies.length, 1, handler);
  return policies[0][1].Properties.PolicyDocument.Statement;
}

function assertOnlyTableActions(statements: any[], allowed: Set<string>) {
  for (const s of statements) {
    const actions = [s.Action].flat();
    assert.ok(actions.every((a: string) => allowed.has(a)), `unexpected actions ${actions}`);
    const res = [s.Resource].flat();
    assert.ok(res.length > 0 && res.every((r: unknown) => r !== '*'));
    assert.match(JSON.stringify(res), /TableXXXXXXXX|Table[0-9A-F]{8}/);
  }
}

test('IAM: only item actions, only on the table ARN, never Resource "*"; only the scrub function may Scan', () => {
  assert.equal(resources('AWS::IAM::Policy').length, 2);
  const request = statementsFor('handler.handler');
  assertOnlyTableActions(request, new Set(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem',
    'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:ConditionCheckItem']));
  assert.ok(!JSON.stringify(request).includes('dynamodb:Scan'), 'the request function never scans');
  const scrub = statementsFor('registry.scrub.handler');
  assertOnlyTableActions(scrub, new Set(['dynamodb:Scan', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem']));
  const policies = resources('AWS::IAM::Policy');
  for (const [, r] of [...policies, ...resources('AWS::IAM::Role')]) {
    assert.ok(!JSON.stringify(r).includes('"Resource":"*"'));
  }
});

test('Cognito: Lite plan, no self sign-up, case-insensitive sign-in, invitations expire in 3 days, org_id and role not writable by the app client', () => {
  t.hasResourceProperties('AWS::Cognito::UserPool', {
    UserPoolTier: 'LITE',
    AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
  });
  t.hasResourceProperties('AWS::Cognito::UserPool', {
    UsernameConfiguration: { CaseSensitive: false },
    Policies: { PasswordPolicy: { TemporaryPasswordValidityDays: 3, MinimumLength: 8, RequireLowercase: true,
      RequireUppercase: true, RequireNumbers: true, RequireSymbols: true } },
  });
  const [[, client]] = resources('AWS::Cognito::UserPoolClient');
  const writable: string[] = client.Properties.WriteAttributes;
  assert.ok(writable.length > 0 && !writable.some((a) => a.startsWith('custom:')));
  assert.ok(client.Properties.ReadAttributes.includes('custom:org_id'));
  assert.equal(client.Properties.GenerateSecret, false);
});

const unlessPaused = (value: number) => ({ 'Fn::If': ['IsPaused', 0, value] });

test('HTTP API: default stage throttled at rate 2, burst 5 (sized for about 5 users), 0 while paused', () => {
  t.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
    StageName: '$default',
    AutoDeploy: true,
    DefaultRouteSettings: { ThrottlingRateLimit: unlessPaused(2), ThrottlingBurstLimit: unlessPaused(5) },
  });
});

test('R56: TrafficPaused (default false) pauses both throttles, the stage default and the public route, and nothing else', () => {
  t.hasParameter('TrafficPaused', { Type: 'String', Default: 'false', AllowedValues: ['false', 'true'] });
  assert.deepEqual(json.Conditions.IsPaused, { 'Fn::Equals': [{ Ref: 'TrafficPaused' }, 'true'] });
  const [[, stage]] = resources('AWS::ApiGatewayV2::Stage');
  for (const settings of [stage.Properties.DefaultRouteSettings, stage.Properties.RouteSettings['GET /v1/shares/{token}']]) {
    assert.deepEqual(settings.ThrottlingRateLimit['Fn::If'].slice(0, 2), ['IsPaused', 0]);
    assert.deepEqual(settings.ThrottlingBurstLimit['Fn::If'].slice(0, 2), ['IsPaused', 0]);
  }
  // Only the stage reads the condition: the table, user pool, functions and budget never change with it.
  const users = Object.entries(json.Resources as Record<string, any>)
    .filter(([, r]) => JSON.stringify(r).includes('IsPaused')).map(([, r]) => r.Type);
  assert.deepEqual(users, ['AWS::ApiGatewayV2::Stage']);
});

test('R52: the scrub function runs daily, 60 s, own 7-day log group, TABLE_NAME only', () => {
  const [scrubId, scrub] = fnByHandler('registry.scrub.handler');
  assert.equal(scrub.Properties.Timeout, 60);
  assert.equal(scrub.Properties.MemorySize, 128);
  assert.deepEqual(Object.keys(scrub.Properties.Environment.Variables), ['TABLE_NAME']);
  const [, request] = fnByHandler('handler.handler');
  assert.notDeepEqual(scrub.Properties.LoggingConfig.LogGroup, request.Properties.LoggingConfig.LogGroup);
  t.resourcePropertiesCountIs('AWS::Logs::LogGroup', { RetentionInDays: 7 }, 2);
  const rules = resources('AWS::Events::Rule');
  assert.equal(rules.length, 1);
  assert.equal(rules[0][1].Properties.ScheduleExpression, 'rate(1 day)');
  assert.deepEqual(rules[0][1].Properties.Targets.map((x: any) => x.Arn), [{ 'Fn::GetAtt': [scrubId, 'Arn'] }]);
});

test('every route has the JWT authorizer except GET /v1/shares/{token}', () => {
  const routes = resources('AWS::ApiGatewayV2::Route').map(([, r]) => r.Properties);
  assert.equal(routes.length, 18);
  for (const key of ['GET /v1/shares', 'DELETE /v1/registrations/{id}/shares/{shareId}']) {
    assert.ok(routes.some((r) => r.RouteKey === key), key);
  }
  for (const key of ['GET /v1/pilot-keys/challenge', 'POST /v1/pilot-keys', 'POST /v1/pilot-keys/{fp}/retire']) {
    assert.ok(routes.some((r) => r.RouteKey === key), key);
  }
  for (const r of routes) {
    if (r.RouteKey === 'GET /v1/shares/{token}') {
      assert.ok(r.AuthorizationType === undefined || r.AuthorizationType === 'NONE');
      assert.equal(r.AuthorizerId, undefined);
    } else {
      assert.equal(r.AuthorizationType, 'JWT', r.RouteKey);
      assert.ok(r.AuthorizerId);
    }
  }
  t.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', { AuthorizerType: 'JWT' });
});

test('budget is optional: conditional on a non-empty BudgetEmail, amount defaults to 5 USD', () => {
  t.hasParameter('BudgetEmail', { Type: 'String', Default: '' });
  t.hasParameter('BudgetAmountUsd', { Type: 'Number', Default: 5 });
  const [[, budget]] = resources('AWS::Budgets::Budget');
  assert.equal(budget.Condition, 'HasBudgetEmail');
  assert.ok(json.Conditions.HasBudgetEmail);
  assert.ok(!JSON.stringify(json).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/), 'no hardcoded email');
});

test('restore mode serves the restored table, closed by RESTORED_FROM, with the grant on that table only', () => {
  const r = Template.fromStack(new RegistryStack(new App(), 'Restored', {
    restoredTableName: 'registry-restored', restoredFrom: 'registry-live', restoreId: 'r-2026-11-17' }));
  r.hasResourceProperties('AWS::Lambda::Function', {
    Environment: { Variables: { TABLE_NAME: 'registry-restored', RESTORED_FROM: 'registry-live',
      RESTORE_ID: 'r-2026-11-17', IDENTITY_ADAPTER: 'cognito' } },
  });
  const policy = JSON.stringify(Object.values(r.toJSON().Resources as Record<string, any>)
    .filter((x) => x.Type === 'AWS::IAM::Policy').map((x) => x.Properties.PolicyDocument));
  assert.ok(policy.includes(':table/registry-restored'));
  assert.ok(!policy.includes('"Resource":"*"'));
  assert.throws(() => new RegistryStack(new App(), 'Half', { restoredTableName: 'x' }));
  assert.throws(() => new RegistryStack(new App(), 'NoId', { restoredTableName: 'x', restoredFrom: 'y' }));
});

test('the public share check has its own tighter throttle (2 rps, burst 5); other routes use the stage default', () => {
  const [[, stage]] = resources('AWS::ApiGatewayV2::Stage');
  assert.deepEqual(stage.Properties.RouteSettings, {
    'GET /v1/shares/{token}': { ThrottlingRateLimit: unlessPaused(2), ThrottlingBurstLimit: unlessPaused(5) },
  });
  assert.deepEqual(stage.Properties.DefaultRouteSettings,
    { ThrottlingRateLimit: unlessPaused(2), ThrottlingBurstLimit: unlessPaused(5) });
  // route settings name a route key, so the stage must be created after that route
  const [publicRouteId] = resources('AWS::ApiGatewayV2::Route')
    .find(([, r]) => r.Properties.RouteKey === 'GET /v1/shares/{token}')!;
  assert.ok([stage.DependsOn].flat().includes(publicRouteId));
});

test('CORS on the HTTP API: only the allowlisted origins, Authorization allowed, Retry-After exposed, never "*", no credentials', () => {
  const [[, api]] = resources('AWS::ApiGatewayV2::Api');
  const cors = api.Properties.CorsConfiguration;
  assert.deepEqual(cors.AllowOrigins, ['https://anirudh763.github.io']);
  assert.deepEqual([...cors.AllowHeaders].sort(), ['authorization', 'content-type', 'idempotency-key']);
  assert.deepEqual([...cors.AllowMethods].sort(), ['DELETE', 'GET', 'OPTIONS', 'POST']);
  assert.deepEqual(cors.ExposeHeaders, ['retry-after']);
  assert.notEqual(cors.AllowCredentials, true);
  assert.ok(!JSON.stringify(cors).includes('*'));
  const custom = Template.fromStack(new RegistryStack(new App(), 'Cors', { corsOrigins: ['https://example.org'] }));
  custom.hasResourceProperties('AWS::ApiGatewayV2::Api', { CorsConfiguration: { AllowOrigins: ['https://example.org'] } });
  assert.throws(() => new RegistryStack(new App(), 'Star', { corsOrigins: ['*'] }));
  assert.throws(() => new RegistryStack(new App(), 'Wild', { corsOrigins: ['https://*.github.io'] }));
  assert.throws(() => new RegistryStack(new App(), 'Http', { corsOrigins: ['http://example.org'] }));
  assert.throws(() => new RegistryStack(new App(), 'None', { corsOrigins: [] }), /at least one/);
});

test('ID and access tokens live 15 minutes, so a demoted admin loses the role quickly', () => {
  t.hasResourceProperties('AWS::Cognito::UserPoolClient', {
    IdTokenValidity: 15, AccessTokenValidity: 15,
    TokenValidityUnits: { IdToken: 'minutes', AccessToken: 'minutes' },
  });
});

test('no fixed-fee services', () => {
  for (const type of ['AWS::KMS::Key', 'AWS::WAFv2::WebACL', 'AWS::EC2::NatGateway', 'AWS::EC2::VPC',
    'AWS::Route53::HostedZone', 'AWS::SecretsManager::Secret']) {
    assert.equal(resources(type).length, 0, type);
  }
});

test('Lambda asset holds only the runtime: handler.py and registry/*.py', () => {
  const app = new App();
  new RegistryStack(app, 'Asset');
  const dir = app.synth().directory;
  const assets = readdirSync(dir).filter((d) => d.startsWith('asset.') && existsSync(join(dir, d, 'handler.py')));
  assert.equal(assets.length, 1);
  const root = join(dir, assets[0]);
  const files = (readdirSync(root, { recursive: true }) as string[])
    .filter((f) => statSync(join(root, f)).isFile()).map((f) => f.split(sep).join('/')).sort();
  assert.ok(files.includes('handler.py') && files.includes('registry/app.py'));
  for (const f of files) assert.match(f, /^(handler\.py|registry\/[a-z0-9_]+\.py)$/, `unexpected file in asset: ${f}`);
});

test('prod reads restore settings only from a committed infra/restore.json, so a plain deploy keeps the restore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'restore-'));
  const file = join(dir, 'restore.json');
  const put = (v: string) => writeFileSync(file, v);
  const ctx = (m: Record<string, string>) => (k: string) => m[k];
  const saved = { restoredTableName: 'registry-restored', restoredFrom: 'registry-live', restoreId: 'r-1' };
  const prod = () => restoreSettings('prod', ctx({}), file);
  assert.throws(prod, /stage=prod needs infra\/restore\.json: commit \{\}/, 'missing file in prod');
  put('{}');
  assert.deepEqual(prod(), {}, '{} means never restored');
  assert.throws(() => restoreSettings('prod', ctx({ restoredTableName: 'x' }), file), /restore\.json, not with -c/);
  put(JSON.stringify(saved));
  Template.fromStack(new RegistryStack(new App(), 'ProdRestored', { stage: 'prod', ...prod() }))
    .hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: { TABLE_NAME: 'registry-restored', RESTORED_FROM: 'registry-live', RESTORE_ID: 'r-1' } },
    });
  assert.throws(() => restoreSettings(undefined, ctx({}), file), /records a production restore: synth it with -c stage=prod/,
    'no stage with a recorded restore');
  assert.throws(() => restoreSettings('dev', ctx({}), file), /records a production restore/);
  put(JSON.stringify({ restoredTablename: 'x', restoredFrom: 'y', restoreId: 'z' }));
  assert.throws(prod, /unknown keys restoredTablename/, 'misspelled key');
  put(JSON.stringify({ ...saved, restoreId: '' }));
  assert.throws(prod, /restoreId must be non-empty strings/, 'empty string');
  put(JSON.stringify({ restoredTableName: 'x' }));
  assert.throws(prod, /restoredFrom, restoreId must be non-empty strings/, 'partial');
  put('[]');
  assert.throws(prod, /must be a JSON object/, 'array');
  put('null');
  assert.throws(prod, /must be a JSON object/, 'null');
  put('{"restoredTableName": ');
  assert.throws(prod, /cannot read it as JSON/, 'broken JSON');
  put('{}');
  assert.deepEqual(restoreSettings('dev', ctx(saved), file), saved, 'dev still takes -c context');
  assert.throws(() => new RegistryStack(new App(), 'Same', { stage: 'prod', restoredTableName: 't', restoredFrom: 't',
    restoreId: 'r' }), /restoredFrom must name the table served before the restore/);
});

test('prod is its own stack (HashWingRegistry-prod): a deploy without -c stage=prod cannot reach it', () => {
  assert.equal(stackId('prod'), 'HashWingRegistry-prod');
  assert.equal(stackId(undefined), 'HashWingRegistry');
  assert.equal(stackId('dev'), 'HashWingRegistry');
  // The real app, with the committed infra/restore.json ({}).
  const run = (context: Record<string, string>) => {
    const out = mkdtempSync(join(tmpdir(), 'synth-'));
    execFileSync(process.execPath, [join(__dirname, '..', 'bin', 'app.js')], {
      cwd: join(__dirname, '..', '..'),
      env: { ...process.env, CDK_OUTDIR: out, CDK_CONTEXT_JSON: JSON.stringify(context) },
    });
    const artifacts: Record<string, { type: string }> = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).artifacts;
    return Object.keys(artifacts).filter((a) => artifacts[a].type === 'aws:cloudformation:stack');
  };
  assert.deepEqual(run({ stage: 'prod' }), ['HashWingRegistry-prod']);
  for (const context of [{}, { Stage: 'prod' }, { stgae: 'prod' }] as Array<Record<string, string>>) {
    assert.deepEqual(run(context), ['HashWingRegistry'], `misspelt or missing stage ${JSON.stringify(context)}`);
  }
});
