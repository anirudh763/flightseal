import {
  CfnCondition, CfnOutput, CfnParameter, Duration, Fn, RemovalPolicy, Stack, StackProps,
  aws_apigatewayv2 as apigw, aws_apigatewayv2_authorizers as authorizers,
  aws_apigatewayv2_integrations as integrations, aws_budgets as budgets, aws_cognito as cognito,
  aws_dynamodb as dynamodb, aws_lambda as lambda, aws_logs as logs,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface RegistryStackProps extends StackProps {
  /** DynamoDB point-in-time recovery. Off by default: it is billed per GB-month (see docs/aws/COST.md). */
  readonly pitr?: boolean;
}

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
  [apigw.HttpMethod.POST, '/v1/shares'],
  [apigw.HttpMethod.DELETE, '/v1/shares/{token}'],
];
export const PUBLIC_ROUTE: [apigw.HttpMethod, string] = [apigw.HttpMethod.GET, '/v1/shares/{token}'];

export class RegistryStack extends Stack {
  constructor(scope: Construct, id: string, props: RegistryStackProps = {}) {
    super(scope, id, props);

    const table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.pitr ?? false },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const logGroup = new logs.LogGroup(this, 'FunctionLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const fn = new lambda.Function(this, 'Function', {
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(5),
      handler: 'handler.handler',
      code: lambda.Code.fromAsset('../registry', { exclude: ['tests', 'localstack', '**/__pycache__'] }),
      logGroup,
      environment: { TABLE_NAME: table.tableName, IDENTITY_ADAPTER: 'cognito' },
    });
    // Explicit item-level actions only, scoped to this table. TransactWriteItems is authorised through them.
    table.grant(fn, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem',
      'dynamodb:Query', 'dynamodb:ConditionCheckItem');

    const userPool = new cognito.UserPool(this, 'Users', {
      featurePlan: cognito.FeaturePlan.LITE,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      customAttributes: {
        org_id: new cognito.StringAttribute({ minLen: 1, maxLen: 64, mutable: false }),
        role: new cognito.StringAttribute({ minLen: 1, maxLen: 16, mutable: true }),
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const client = userPool.addClient('WebClient', {
      authFlows: { userSrp: true },
      generateSecret: false,
      readAttributes: new cognito.ClientAttributes()
        .withStandardAttributes({ email: true })
        .withCustomAttributes('org_id', 'role'),
      // The app client may not write org_id or role: only an administrator (AdminUpdateUserAttributes) can.
      writeAttributes: new cognito.ClientAttributes().withStandardAttributes({ email: true }),
    });

    const api = new apigw.HttpApi(this, 'Api', { createDefaultStage: false });
    new apigw.HttpStage(this, 'DefaultStage', {
      httpApi: api,
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: 10, burstLimit: 20 },
    });
    const integration = new integrations.HttpLambdaIntegration('Lambda', fn);
    // The client sends the Cognito ID token: custom:org_id and custom:role are in the ID token on the Lite plan.
    const jwt = new authorizers.HttpUserPoolAuthorizer('Cognito', userPool, { userPoolClients: [client] });
    for (const [method, path] of ROUTES) {
      api.addRoutes({ path, methods: [method], integration, authorizer: jwt });
    }
    api.addRoutes({ path: PUBLIC_ROUTE[1], methods: [PUBLIC_ROUTE[0]], integration });

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
