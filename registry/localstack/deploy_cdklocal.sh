#!/usr/bin/env bash
# Deploy the real CDK stack (HTTP API + Cognito) to LocalStack Pro with cdklocal, then run the e2e scenarios
# against the HTTP API URL. The community image cannot do this: apigatewayv2 and cognito-idp are not in its plan.
# NOT RUN in this repository's evidence (no Pro licence). Never targets real AWS.
set -euo pipefail

if [ -z "${LOCALSTACK_AUTH_TOKEN:-}" ]; then
  echo "LOCALSTACK_AUTH_TOKEN is not set: the HTTP API and Cognito need LocalStack Pro. Nothing was started." >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NAME=hashwing-localstack-pro
PORT=4599
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1
export AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null
export AWS_ENDPOINT_URL="http://127.0.0.1:${PORT}" EDGE_PORT="${PORT}" LOCALSTACK_HOSTNAME=127.0.0.1
unset AWS_PROFILE AWS_SESSION_TOKEN

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  # Lambda containers LocalStack started for this instance
  docker ps -aq --filter "name=${NAME}-lambda" | xargs -r docker rm -f >/dev/null 2>&1 || true
}
trap cleanup EXIT

# The token is passed by name only (-e VAR), so it is never echoed or put on a command line.
docker run -d --name "$NAME" -p "127.0.0.1:${PORT}:4566" -e LOCALSTACK_AUTH_TOKEN \
  -e MAIN_CONTAINER_NAME="$NAME" -v /var/run/docker.sock:/var/run/docker.sock \
  localstack/localstack-pro:4.12.0 >/dev/null
for _ in $(seq 1 90); do
  curl -fs "http://127.0.0.1:${PORT}/_localstack/health" >/dev/null && break
  sleep 2
done

cd "$ROOT/infra"
npm ci
npm run build
npx cdklocal bootstrap
npx cdklocal deploy --require-approval never --outputs-file cdk.out/outputs.json
out() { node -e "const o=require('./cdk.out/outputs.json').HashWingRegistry; process.stdout.write(o['$1'])"; }
API_URL="$(out ApiUrl)"; POOL="$(out UserPoolId)"; CLIENT="$(out UserPoolClientId)"; TABLE="$(out TableName)"

# LocalStack only: let the script mint ID tokens with admin auth (the deployed client allows SRP only).
uv run --no-project --with boto3==1.43.123 python -c '
import sys, boto3
boto3.client("cognito-idp", endpoint_url=sys.argv[1]).update_user_pool_client(
    UserPoolId=sys.argv[2], ClientId=sys.argv[3],
    ExplicitAuthFlows=["ALLOW_ADMIN_USER_PASSWORD_AUTH", "ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"])
' "$AWS_ENDPOINT_URL" "$POOL" "$CLIENT"

cd "$ROOT"
uv run --no-project --with boto3==1.43.123 python registry/localstack/e2e.py \
  --api-url "$API_URL" --user-pool-id "$POOL" --client-id "$CLIENT" --table-name "$TABLE"
