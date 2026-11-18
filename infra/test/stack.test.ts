import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { RegistryStack } from '../lib/stack';
import { existsSync, readdirSync, statSync } from 'node:fs';
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

test('Lambda: python3.12, arm64, 128 MB, 5 s, cognito adapter, no DEV_ variables', () => {
  t.resourceCountIs('AWS::Lambda::Function', 1);
  t.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'python3.12',
    Architectures: ['arm64'],
    MemorySize: 128,
    Timeout: 5,
    Handler: 'handler.handler',
    Environment: { Variables: { IDENTITY_ADAPTER: 'cognito', TABLE_NAME: Match.anyValue() } },
  });
  const [[, fn]] = resources('AWS::Lambda::Function');
  assert.deepEqual(Object.keys(fn.Properties.Environment.Variables).sort(), ['IDENTITY_ADAPTER', 'TABLE_NAME']);
  assert.ok(!JSON.stringify(json).includes('DEV_'), 'no DEV_ setting anywhere in the template');
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

test('IAM: only item actions, only on the table ARN, never Resource "*"', () => {
  const policies = resources('AWS::IAM::Policy');
  assert.equal(policies.length, 1);
  const statements = policies[0][1].Properties.PolicyDocument.Statement;
  const allowed = new Set(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem',
    'dynamodb:Query', 'dynamodb:ConditionCheckItem']);
  for (const s of statements) {
    const actions = [s.Action].flat();
    assert.ok(actions.every((a: string) => allowed.has(a)), `unexpected actions ${actions}`);
    const res = [s.Resource].flat();
    assert.ok(res.length > 0 && res.every((r: unknown) => r !== '*'));
    assert.match(JSON.stringify(res), /TableXXXXXXXX|Table[0-9A-F]{8}/);
  }
  for (const [, r] of [...policies, ...resources('AWS::IAM::Role')]) {
    assert.ok(!JSON.stringify(r).includes('"Resource":"*"'));
  }
});

test('Cognito: Lite plan, no self sign-up, org_id and role not writable by the app client', () => {
  t.hasResourceProperties('AWS::Cognito::UserPool', {
    UserPoolTier: 'LITE',
    AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
  });
  const [[, client]] = resources('AWS::Cognito::UserPoolClient');
  const writable: string[] = client.Properties.WriteAttributes;
  assert.ok(writable.length > 0 && !writable.some((a) => a.startsWith('custom:')));
  assert.ok(client.Properties.ReadAttributes.includes('custom:org_id'));
  assert.equal(client.Properties.GenerateSecret, false);
});

test('HTTP API: default stage throttled at rate 10, burst 20', () => {
  t.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
    StageName: '$default',
    AutoDeploy: true,
    DefaultRouteSettings: { ThrottlingRateLimit: 10, ThrottlingBurstLimit: 20 },
  });
});

test('every route has the JWT authorizer except GET /v1/shares/{token}', () => {
  const routes = resources('AWS::ApiGatewayV2::Route').map(([, r]) => r.Properties);
  assert.equal(routes.length, 13);
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

test('the public share check has its own tighter throttle (2 rps, burst 5); other routes keep the stage default', () => {
  const [[, stage]] = resources('AWS::ApiGatewayV2::Stage');
  assert.deepEqual(stage.Properties.RouteSettings, {
    'GET /v1/shares/{token}': { ThrottlingRateLimit: 2, ThrottlingBurstLimit: 5 },
  });
  assert.deepEqual(stage.Properties.DefaultRouteSettings, { ThrottlingRateLimit: 10, ThrottlingBurstLimit: 20 });
  // route settings name a route key, so the stage must be created after that route
  const [publicRouteId] = resources('AWS::ApiGatewayV2::Route')
    .find(([, r]) => r.Properties.RouteKey === 'GET /v1/shares/{token}')!;
  assert.ok([stage.DependsOn].flat().includes(publicRouteId));
});

test('CORS on the HTTP API: only the allowlisted origins, Authorization allowed, never "*", no credentials', () => {
  const [[, api]] = resources('AWS::ApiGatewayV2::Api');
  const cors = api.Properties.CorsConfiguration;
  assert.deepEqual(cors.AllowOrigins, ['https://anirudh763.github.io']);
  assert.deepEqual([...cors.AllowHeaders].sort(), ['authorization', 'content-type', 'idempotency-key']);
  assert.deepEqual([...cors.AllowMethods].sort(), ['DELETE', 'GET', 'OPTIONS', 'POST']);
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
