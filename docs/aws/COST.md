# Registry cost estimate (us-east-1)

**Pricing date:** 2026-11-17. **Region:** US East (N. Virginia). Nothing here is a bill: the stack has never been
deployed, and every duration below is an estimate, not a measurement on Lambda.

**$5 a month is a target, not a cap.** An AWS Budget only sends an email when actual or forecast spend crosses a
threshold. It does not stop resources, reject requests or limit spend. Under sustained abuse this stack can cost more
than $5 (see the abuse scenario). The budget response is an operator step: redeploy with `TrafficPaused=true`, which
sets both stage throttles to 0 and keeps the data (see "When the budget alert fires" in
[RUNBOOK_AWS.md](RUNBOOK_AWS.md)). Spend keeps accruing until someone does that, billing data reaches the budget
hours late, and whether requests refused by a throttle of 0 are billed is not verified.

## Where the rates come from

The plan allows rates only from aws.amazon.com pricing pages. Those pages load their rate tables with JavaScript, so
the fetched pages contained free-tier text and worked examples but **no us-east-1 rate tables**. Every rate below is
therefore marked **page: not retrieved**. The figure next to it comes from AWS's official Price List file for
us-east-1, downloaded on 2026-11-17, and was checked against the downloaded bytes (SKU description and
`pricePerUnit`). It is shown as a secondary source, and the estimates below use it.

| Service | Item | aws.amazon.com page | Price List figure | Price List file (publication date) |
|---|---|---|---|---|
| API Gateway HTTP API | requests, first 300 M a month | [not retrieved](https://aws.amazon.com/api-gateway/pricing/) | $1.00 per million ("$1/million requests - API Gateway HTTP API (first 300 million)") | [AmazonApiGateway](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonApiGateway/current/us-east-1/index.json) (2026-11-12) |
| API Gateway HTTP API | 512 KB metering unit | not retrieved: shown only inside a worked example with no region | — | — |
| Lambda arm64 | compute, first 7.5 B GB-s | [not retrieved](https://aws.amazon.com/lambda/pricing/) | $0.0000133334 per GB-s ("Total Compute for ARM ... Tier-1") | [AWSLambda](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSLambda/current/us-east-1/index.json) (2026-11-11) |
| Lambda arm64 | requests | not retrieved | $0.0000002 per request = $0.20 per million ("Total Requests for ARM") | [AWSLambda](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSLambda/current/us-east-1/index.json) |
| DynamoDB on demand | write request units | [not retrieved](https://aws.amazon.com/dynamodb/pricing/on-demand/) | $0.625 per million ("per million write request units (N. Virginia)") | [AmazonDynamoDB](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonDynamoDB/current/us-east-1/index.json) (2026-11-11) |
| DynamoDB on demand | read request units | not retrieved | $0.125 per million | [AmazonDynamoDB](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonDynamoDB/current/us-east-1/index.json) |
| DynamoDB | transactional writes | **seen on the page**: "2 WRUs per 1 KB or part thereof" | — | — |
| DynamoDB | storage | not retrieved | $0.00 for the first 25 GB-month, then $0.25 per GB-month | [AmazonDynamoDB](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonDynamoDB/current/us-east-1/index.json) |
| DynamoDB | PITR | not retrieved | $0.20 per GB-month | [AmazonDynamoDB](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonDynamoDB/current/us-east-1/index.json) |
| CloudWatch Logs | ingestion, Standard class | [not retrieved](https://aws.amazon.com/cloudwatch/pricing/) | $0.50 per GB | [AmazonCloudWatch](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonCloudWatch/current/us-east-1/index.json) (2026-11-16) |
| CloudWatch Logs | storage | not retrieved | $0.03 per GB-month | [AmazonCloudWatch](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonCloudWatch/current/us-east-1/index.json) |
| Cognito, Lite plan | MAU, tier 1 | [not retrieved](https://aws.amazon.com/cognito/pricing/) | $0.0055 per MAU ("Cognito Lite us-east-1 tier 1") | [AmazonCognito](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonCognito/current/us-east-1/index.json) (2026-10-20) |
| Data transfer out | internet, first 10 TB | [not retrieved](https://aws.amazon.com/ec2/pricing/on-demand/) | $0.09 per GB | [AWSDataTransfer](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/us-east-1/index.json) (2026-11-17) |
| AWS Budgets | monitoring and notifications | **seen on the page**: "free of charge" ([AWS Budgets pricing](https://aws.amazon.com/aws-cost-management/aws-budgets/pricing/)) | — | — |

Free tiers seen on the official pages ([API Gateway](https://aws.amazon.com/api-gateway/pricing/),
[Lambda](https://aws.amazon.com/lambda/pricing/), [CloudWatch](https://aws.amazon.com/cloudwatch/pricing/),
[Cognito](https://aws.amazon.com/cognito/pricing/), [EC2 data transfer](https://aws.amazon.com/ec2/pricing/on-demand/)):
1 M HTTP API calls a month for the first 12 months; 1 M Lambda requests and 400,000 GB-s a month; 5 GB of
CloudWatch Logs data; 10,000 Cognito Lite MAUs per account; 100 GB of data out to the internet a month. The
estimates below **ignore every free tier**, so they are the cost after the free tiers run out or for an account that
already uses them.

## Baseline workload

1 company, 5 users (5 MAU), 1,000 registrations and 5,000 public checks a month.

Assumed requests: 1,000 envelopes, 1,000 registrations, 1,000 shares created, 5,000 public checks, 500 other calls
(lists, keys), so **8,500 API requests** a month.

Retention: logs 7 days; envelopes and idempotency records 7 days; challenges 5 minutes; shares 30 days by default;
registrations and tombstones are kept until deleted. About 300 bytes per registration, so the table grows by roughly
0.3 MB a month.

Lambda duration (estimate): pure-Python Ed25519 verification takes 5.4 ms on an Apple M1 Pro core (measured locally).
A 128 MB function gets a small share of a vCPU, so this assumes 300 ms per registration and 50 ms for every other
request, billed at 0.125 GB.

| Item | Quantity | Cost / month |
|---|---|---|
| HTTP API requests | 8,500 | $0.0085 |
| Lambda requests | 8,500 | $0.0017 |
| Lambda compute | 1,000 × 0.3 s × 0.125 GB + 7,500 × 0.05 s × 0.125 GB = 84 GB-s | $0.0011 |
| DynamoDB writes | envelopes 1,000 × 1 + registrations 1,000 × 3 items × 2 + shares 1,000 × 4 items × 2 (SHARE, the REG update, SIDEM, the list index item) = 15,000 WRU | $0.0094 |
| DynamoDB reads (strongly consistent) | registrations 4,000 + envelopes 1,000 + shares 1,000 + checks 10,000 + other 1,000 = 17,000 RRU | $0.0021 |
| DynamoDB storage | under 0.01 GB (inside the 25 GB free storage tier in the price list) | $0.0000 |
| PITR (only with `-c stage=prod` or `-c pitr=true`) | under 0.01 GB | under $0.0020 |
| CloudWatch Logs | about 350 bytes per invocation (one app line plus the platform lines): 3 MB ingested, 7 days kept | $0.0015 |
| Cognito Lite | 5 MAU | $0.0275 |
| Data out | about 500 bytes per response: 4 MB | $0.0004 |
| Daily scrub (R52) | 30 invocations × at most 60 s × 0.125 GB; two strongly consistent Scans a day of a table under 1 MB (at most about 512 RRU a day) | under $0.003 |
| EventBridge schedule | one rule, 30 scheduled invocations | not priced here (no fixed fee) |
| AWS Budgets | one cost budget with email alerts | $0.00 |
| **Total** | | **about $0.06** (about $0.05 before the share list index item and the daily scrub) |

## Error and retry scenario

Every registration is retried three more times (lost responses, a flaky network), and 10 % of all other requests
fail and are retried once.

- 3,000 extra registration calls. Each one hits the idempotency record before any write: 2 RRU (IDEM and REG reads),
  no WRU, no quota charge. Cost: API $0.0030, Lambda requests $0.0006, Lambda compute 3,000 × 0.05 s × 0.125 GB =
  19 GB-s ($0.0003), reads 6,000 RRU ($0.0008), logs about 1 MB ($0.0005).
- 750 other retries: under $0.002 in all.
- **Total with retries: about $0.06 a month.** Retries cost little because a retry is answered from the
  idempotency record and never repeats the transaction.

## Abuse scenario

Someone sends public share checks with random, well-formed tokens, every second of a 30-day month. The public route
`GET /v1/shares/{token}` now has its own route throttle of **2 requests a second, burst 5**. The signed-in routes
use the stage default, which is also 2 a second, burst 5 (see "Signed-in routes" below). So the flood reaches the Lambda at most 2 × 86,400 × 30 =
**5.184 M times a month**. The rates are the same Price List figures as above.

| Item | Quantity | Cost / month |
|---|---|---|
| HTTP API requests | 5.184 M × $1.00 per million | $5.18 |
| Lambda requests | 5.184 M × $0.20 per million | $1.04 |
| Lambda compute | 5.184 M × 0.02 s × 0.125 GB = 12,960 GB-s × $0.0000133334 | $0.17 |
| DynamoDB reads | 1 RRU per check (the share lookup misses): 5.184 M × $0.125 per million | $0.65 |
| CloudWatch Logs | about 350 bytes per invocation: 1.81 GB × $0.50 per GB | $0.91 |
| **Total** | | **about $8** (it was about $40 when the stage limit of 10 a second also applied here) |

**About $8 assumes throttled requests are free.** It is not known whether API Gateway bills the requests it
throttles with a 429 (see "Still not a cap" below). If those are billed, the HTTP API line grows with the
attacker's send rate, not with the 2-a-second throttle.

**Why 2 a second, burst 5.** The baseline is 5,000 checks a month, which averages 0.002 a second. A person opening a
handful of links at once fits inside the burst of 5, and a steady 2 a second is still about 1,000 times the baseline
average. Going lower (for example 1 a second, about $4) would get under $5, but it would start rejecting a
recipient's page that opens several shared links at once. 2 a second is the smallest round limit that keeps that
case working.

The throttle protects the bill, not availability. While the flood runs, real link checks share those 2 a second,
so they get 429s. The signed-in routes have their own limits and keep working.

**Still not a cap.**

What AWS's own pages say was checked on 2026-11-17. Neither question is settled for HTTP APIs, so both stay open:

- **Are rejected or throttled requests billed?** Not settled.
  - [API Gateway pricing](https://aws.amazon.com/api-gateway/pricing/) says only: "For HTTP APIs and REST APIs, you
    pay only for the API calls you receive and the amount of data transferred out." It does not say whether a call
    that fails the JWT authorizer, or one that gets a 429, counts as received.
  - The [API Gateway FAQ](https://aws.amazon.com/api-gateway/faqs/) says, for WebSocket APIs only: "if messages
    on the WebSocket connection fail authentication or authorization, they do not count toward your API usage bill". It says nothing like this for HTTP or REST
    APIs, or about throttled requests of any API type.
  - Forum answers on re:Post say failed-authorization calls are not charged. They are not AWS documentation and are
    not relied on here.

  If 429s are billed, the HTTP API line grows with the attacker's send rate at $1.00 per million, and nothing caps
  it. Only the Lambda, DynamoDB and log lines stay capped by the throttle.
- **Is the stage default per route or shared?** Not settled.
  - The [HTTP API throttling page](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-throttling.html)
    says: "You can set route-level throttling to override the account-level request throttling limits for a specific
    stage or for individual routes in your API." It does not say whether a stage-wide default is one shared bucket or
    one bucket per route.
  - The CloudFormation [`DefaultRouteSettings`](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-apigatewayv2-stage.html)
    and [`RouteSettings`](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-apigatewayv2-stage-routesettings.html)
    pages say only "The default route settings for the stage" and "Specifies the throttling rate limit".
  - Only the REST API page ([REST throttling](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-request-throttling.html))
    says "Per-API, per-stage throttling limits are applied at the API method level for a stage". That covers REST
    APIs, not HTTP APIs.
- **Signed-in routes, and the design change this led to.** Because neither question is settled, the stage default
  was lowered from 10 a second, burst 20 to **2 a second, burst 5**, which is sized for about 5 users.
  - A flood with invalid tokens is stopped by the JWT authorizer before the Lambda. If authorizer-rejected requests
    are billed:
    - Per-route reading (17 signed-in routes): at most 17 × 2 × 86,400 × 30 = 88.1 M requests a month, about
      **$88**.
    - Shared reading: 5.18 M requests a month, about **$5**.
  - On top of the public-route $8, the worst case with throttled requests free is therefore about **$96 a month**
    (it was about $70 when this was written for 12 signed-in routes).
    Before this change it was about $8 plus $300 under the per-route reading.
  - If throttled requests are billed, there is no ceiling under either reading.
  - The cost of the lower limit: if the limit is shared, a few people signing in at the same moment can get 429s.
    The outbox retries a registration that gets any 429 other than `quota_exceeded`.
  - All of this is unverified on AWS, because the stack has never been deployed.
- **Budget alerts:** they only send email. They do not stop requests or limit spend. When one fires, follow
  "When the budget alert fires" in [RUNBOOK_AWS.md](RUNBOOK_AWS.md): the reversible pause (`TrafficPaused=true`)
  sets both throttles to 0 and keeps the data. It is synthesised and asserted only, never run on AWS.

Ways to lower the ceiling further without fixed-fee services:

- lower the public route throttle
- log only errors
- remove the public route

A WAF would cost a fixed monthly fee and is excluded.
