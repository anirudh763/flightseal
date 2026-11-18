import {
  CfnCondition, CfnOutput, CfnParameter, Duration, Fn, RemovalPolicy, Stack, StackProps,
  aws_apigatewayv2 as apigw, aws_apigatewayv2_authorizers as authorizers,
  aws_apigatewayv2_integrations as integrations, aws_budgets as budgets, aws_cognito as cognito,
  aws_dynamodb as dynamodb, aws_lambda as lambda, aws_logs as logs,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { existsSync, readFileSync } from 'node:fs';

export interface RegistryStackProps extends StackProps {
  /**
   * 'prod' keeps the data: PITR on with a 35-day window, deletion protection, and RETAIN on the table, user pool
   * and log group. 'dev' (the default) is disposable. Choosing prod here does not authorize a deploy.
   */
  readonly stage?: 'dev' | 'prod';
  /** DynamoDB point-in-time recovery in dev. Off by default: it is billed per GB-month (see docs/aws/COST.md). */
  readonly pitr?: boolean;
  /**
   * Serve a table restored from a backup (always a new table, outside this stack) instead of the stack's table.
   * Requires restoredFrom: the function then answers 503 restore_pending until registry.restore has applied the
   * source's tombstones. See docs/aws/RUNBOOK_AWS.md.
   */
  readonly restoredTableName?: string;
  readonly restoredFrom?: string;
  /** A new random ID per restore. The marker written by registry.restore must name it and the restored table. */
  readonly restoreId?: string;
  /**
   * Browser origins allowed to call the API (CORS). Exact https origins only: no "*", no wildcard hosts.
   * API Gateway answers preflight and adds the headers; credentials (cookies) are never allowed.
   */
  readonly corsOrigins?: string[];
}

const RESTORE_KEYS = ['restoredTableName', 'restoredFrom', 'restoreId'] as const;
type RestoreProps = Pick<RegistryStackProps, (typeof RESTORE_KEYS)[number]>;

/**
 * Restore settings. dev: from -c context. prod: only from the committed file (absent = never restored), because
 * free context is forgotten by the next routine deploy, which would serve the original table with the gate open.
 */
export function restoreSettings(stage: unknown, context: (key: string) => unknown, file: string): RestoreProps {
  if (stage !== 'prod') return Object.fromEntries(RESTORE_KEYS.map((k) => [k, context(k)])) as RestoreProps;
  const given = RESTORE_KEYS.filter((k) => context(k) !== undefined);
  if (given.length) throw new Error(`stage=prod: set ${given.join(', ')} in infra/restore.json, not with -c`);
  if (!existsSync(file)) return {};
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  const extra = Object.keys(saved).filter((k) => !(RESTORE_KEYS as readonly string[]).includes(k));
  if (extra.length) throw new Error(`infra/restore.json: unknown keys ${extra.join(', ')}`);
  return saved;
}

export const DEFAULT_CORS_ORIGINS = ['https://anirudh763.github.io'];
const CORS_ORIGIN = /^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$/;

/** Routes served by the Lambda. Only the public share check has no authorizer. */
export const ROUTES: Array<[apigw.HttpMethod, string]> = [
  [apigw.HttpMethod.POST, '/v1/envelopes'],
  [apigw.HttpMethod.POST, '/v1/registrations'],
  [apigw.HttpMethod.GET, '/v1/registrations'],
  [apigw.HttpMethod.DELETE, '/v1/registrations/{id}'],
  [apigw.HttpMethod.GET, '/v1/keys/challenge'],
  [apigw.HttpMethod.POST, '/v1/keys'],
  [apigw.HttpMethod.GET, '/v1/keys'],
  [apigw.HttpMethod.POST, '/v1/keys/{fp}/compromised'],
  [apigw.HttpMethod.POST, '/v1/epoch'],
  [apigw.HttpMethod.GET, '/v1/epoch'],
  [apigw.HttpMethod.POST, '/v1/shares'],
  [apigw.HttpMethod.DELETE, '/v1/shares/{token}'],
];
export const PUBLIC_ROUTE: [apigw.HttpMethod, string] = [apigw.HttpMethod.GET, '/v1/shares/{token}'];
export const PUBLIC_THROTTLE = { rate: 2, burst: 5 };
// Default for every signed-in route, sized for about 5 users (docs/aws/COST.md). AWS does not say whether HTTP API
// default route settings apply per route or are shared, or whether rejected or throttled requests are billed.
export const STAGE_THROTTLE = { rate: 2, burst: 5 };

export class RegistryStack extends Stack {
  constructor(scope: Construct, id: string, props: RegistryStackProps = {}) {
    super(scope, id, props);
    if (props.stage !== undefined && props.stage !== 'dev' && props.stage !== 'prod') {
      throw new Error(`stage: ${JSON.stringify(props.stage)} is not 'dev' or 'prod'`);
    }
    const prod = props.stage === 'prod';
    const removalPolicy = prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    // undefined, not false, in dev: the dev template stays as it was before the switch existed.
    const deletionProtection = prod || undefined;

    const table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: prod
        ? { pointInTimeRecoveryEnabled: true, recoveryPeriodInDays: 35 }
        : { pointInTimeRecoveryEnabled: props.pitr ?? false },
      deletionProtection,
      removalPolicy,
    });

    if (!props.restoredTableName !== !props.restoredFrom || !props.restoredTableName !== !props.restoreId) {
      throw new Error('restoredTableName, restoredFrom and restoreId must be set together');
    }
    const served = props.restoredTableName
      ? dynamodb.Table.fromTableName(this, 'RestoredTable', props.restoredTableName)
      : table;
    const environment: Record<string, string> = { TABLE_NAME: served.tableName, IDENTITY_ADAPTER: 'cognito' };
    if (props.restoredFrom) environment.RESTORED_FROM = props.restoredFrom;
    if (props.restoreId) environment.RESTORE_ID = props.restoreId;

    const logGroup = new logs.LogGroup(this, 'FunctionLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy,
    });

    const fn = new lambda.Function(this, 'Function', {
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(5),
      handler: 'handler.handler',
      code: lambda.Code.fromAsset('../registry', { exclude: ['tests', 'localstack', 'devserver', '**/__pycache__'] }),
      logGroup,
      environment,
    });
    // Explicit item-level actions only, scoped to this table. TransactWriteItems is authorised through them.
    served.grant(fn, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem',
      'dynamodb:Query', 'dynamodb:ConditionCheckItem');

    const userPool = new cognito.UserPool(this, 'Users', {
      featurePlan: cognito.FeaturePlan.LITE,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      // Invitations (admin-created users' temporary passwords) expire after 3 days. The rest restates Cognito's
      // default policy: once Policies is written, an omitted Require* flag means false in CloudFormation.
      passwordPolicy: {
        tempPasswordValidity: Duration.days(3),
        minLength: 8, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: true,
      },
      customAttributes: {
        org_id: new cognito.StringAttribute({ minLen: 1, maxLen: 64, mutable: false }),
        role: new cognito.StringAttribute({ minLen: 1, maxLen: 16, mutable: true }),
      },
      deletionProtection,
      removalPolicy,
    });
    const client = userPool.addClient('WebClient', {
      authFlows: { userSrp: true },
      generateSecret: false,
      readAttributes: new cognito.ClientAttributes()
        .withStandardAttributes({ email: true })
        .withCustomAttributes('org_id', 'role'),
      // The app client may not write org_id or role: only an administrator (AdminUpdateUserAttributes) can.
      writeAttributes: new cognito.ClientAttributes().withStandardAttributes({ email: true }),
      // custom:role is read from the ID token as issued: a demoted admin keeps the role until it expires.
      // Short tokens bound that window; pair a demotion with AdminUserGlobalSignOut (see RUNBOOK_AWS.md).
      idTokenValidity: Duration.minutes(15),
      accessTokenValidity: Duration.minutes(15),
    });

    const corsOrigins = props.corsOrigins ?? DEFAULT_CORS_ORIGINS;
    if (corsOrigins.length === 0) throw new Error('corsOrigins: give at least one origin (omit it for the default)');
    for (const o of corsOrigins) {
      if (!CORS_ORIGIN.test(o)) throw new Error(`corsOrigins: ${JSON.stringify(o)} is not an exact https origin`);
    }
    const api = new apigw.HttpApi(this, 'Api', {
      createDefaultStage: false,
      corsPreflight: {
        allowOrigins: corsOrigins,
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST, apigw.CorsHttpMethod.DELETE,
          apigw.CorsHttpMethod.OPTIONS],
        allowHeaders: ['authorization', 'content-type', 'idempotency-key'],
        allowCredentials: false,
        maxAge: Duration.minutes(10),
      },
    });
    const stage = new apigw.HttpStage(this, 'DefaultStage', {
      httpApi: api,
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: STAGE_THROTTLE.rate, burstLimit: STAGE_THROTTLE.burst },
    });
    const integration = new integrations.HttpLambdaIntegration('Lambda', fn);
    // The client sends the Cognito ID token: custom:org_id and custom:role are in the ID token on the Lite plan.
    const jwt = new authorizers.HttpUserPoolAuthorizer('Cognito', userPool, { userPoolClients: [client] });
    for (const [method, path] of ROUTES) {
      api.addRoutes({ path, methods: [method], integration, authorizer: jwt });
    }
    const [publicRoute] = api.addRoutes({ path: PUBLIC_ROUTE[1], methods: [PUBLIC_ROUTE[0]], integration });
    // The only unauthenticated route gets its own, tighter limit: a flood of random links costs at most
    // PUBLIC_THROTTLE.rate requests a second (see the abuse scenario in docs/aws/COST.md). A person checking links
    // needs far less; the burst covers opening a handful at once. It stays pinned even if STAGE_THROTTLE changes.
    // RouteSettings is a free-form map in CloudFormation, so it is written with its CloudFormation key names.
    (stage.node.defaultChild as apigw.CfnStage).addPropertyOverride('RouteSettings', {
      [`${PUBLIC_ROUTE[0]} ${PUBLIC_ROUTE[1]}`]: {
        ThrottlingRateLimit: PUBLIC_THROTTLE.rate, ThrottlingBurstLimit: PUBLIC_THROTTLE.burst,
      },
    });
    stage.node.addDependency(publicRoute); // route settings must name a route that already exists

    const budgetEmail = new CfnParameter(this, 'BudgetEmail', {
      type: 'String',
      default: '',
      description: 'Optional. When set, creates a monthly cost budget that emails this address. Alerts do not cap spend.',
    });
    const budgetAmount = new CfnParameter(this, 'BudgetAmountUsd', { type: 'Number', default: 5, minValue: 1 });
    const hasEmail = new CfnCondition(this, 'HasBudgetEmail', {
      expression: Fn.conditionNot(Fn.conditionEquals(budgetEmail.valueAsString, '')),
    });
    const subscribers = [{ subscriptionType: 'EMAIL', address: budgetEmail.valueAsString }];
    const budget = new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: budgetAmount.valueAsNumber, unit: 'USD' },
      },
      notificationsWithSubscribers: [
        { notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 80 }, subscribers },
        { notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100 }, subscribers },
      ],
    });
    budget.cfnOptions.condition = hasEmail;

    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    new CfnOutput(this, 'TableName', { value: table.tableName });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: client.userPoolClientId });
  }
}
