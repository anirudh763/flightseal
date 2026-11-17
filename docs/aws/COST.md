# Registry cost estimate (us-east-1)

**Pricing date:** 2026-11-17. **Region:** US East (N. Virginia). Nothing here is a bill: the stack has never been
deployed, and every duration below is an estimate, not a measurement on Lambda.

**$5 a month is a target, not a cap.** An AWS Budget only sends an email when actual or forecast spend crosses a
threshold. It does not stop resources, reject requests or limit spend. Under sustained abuse this stack can cost more
than $5 (see the abuse scenario).

## Where the rates come from

The HTML pricing pages below load their rate tables with JavaScript, so the fetched pages contained only free-tier
text and worked examples. The rates were therefore read from the official AWS Price List files for us-east-1,
`https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<ServiceCode>/current/us-east-1/index.json`, downloaded
on 2026-11-17. These are AWS's own published price files, but they are not the aws.amazon.com pages the plan named,
so each rate is marked with its source.

| Service | Item | Rate | Source |
|---|---|---|---|
| API Gateway HTTP API | requests, first 300 M a month | $1.00 per million | Price List `AmazonApiGateway` |
| API Gateway HTTP API | metering unit | 512 KB per request | **not retrieved** as a rule; the [pricing page](https://aws.amazon.com/api-gateway/pricing/) shows it only inside a worked example with no region named. Registry requests are at most 4 KB, so each counts once either way |
| Lambda arm64 | compute, first 7.5 B GB-s a month | $0.0000133334 per GB-second | Price List `AWSLambda` |
| Lambda arm64 | requests | $0.20 per million | Price List `AWSLambda` |
| DynamoDB on demand | write request units | $0.625 per million | Price List `AmazonDynamoDB` |
| DynamoDB on demand | read request units | $0.125 per million | Price List `AmazonDynamoDB` |
| DynamoDB | transactional writes | 2 WRU per 1 KB item write | [DynamoDB on-demand pricing page](https://aws.amazon.com/dynamodb/pricing/on-demand/) |
| DynamoDB | storage, Standard class | first 25 GB-month $0.00, then $0.25 per GB-month | Price List `AmazonDynamoDB` |
| DynamoDB | PITR (continuous backups) | $0.20 per GB-month | Price List `AmazonDynamoDB` |
| CloudWatch Logs | ingestion, Standard class | $0.50 per GB | Price List `AmazonCloudWatch` |
| CloudWatch Logs | storage | $0.03 per GB-month | Price List `AmazonCloudWatch` |
| Cognito, Lite plan | MAU, first tier | $0.0055 per MAU | Price List `AmazonCognito` (`USE1-CognitoLiteMAU`) |
| Data transfer out | to the internet, first 10 TB | $0.09 per GB | Price List `AWSDataTransfer` |
| AWS Budgets | monitoring and notifications | free | [AWS Budgets pricing page](https://aws.amazon.com/aws-cost-management/aws-budgets/pricing/) |

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
| DynamoDB writes | envelopes 1,000 × 1 + registrations 1,000 × 3 items × 2 + shares 1,000 × 2 items × 2 = 11,000 WRU | $0.0069 |
| DynamoDB reads (strongly consistent) | registrations 4,000 + envelopes 1,000 + shares 1,000 + checks 10,000 + other 1,000 = 17,000 RRU | $0.0021 |
| DynamoDB storage | under 0.01 GB (inside the 25 GB free storage tier in the price list) | $0.0000 |
| PITR (only if `-c pitr=true`) | under 0.01 GB | under $0.0020 |
| CloudWatch Logs | about 350 bytes per invocation (one app line plus the platform lines): 3 MB ingested, 7 days kept | $0.0015 |
| Cognito Lite | 5 MAU | $0.0275 |
| Data out | about 500 bytes per response: 4 MB | $0.0004 |
| AWS Budgets | one cost budget with email alerts | $0.00 |
| **Total** | | **about $0.05** |

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

Someone sends public share checks with random, well-formed tokens as fast as the stage throttle allows: 10 requests a
second, every second of a 30-day month, which is 25.92 M requests. (The throttle is for the whole stage, so this also
locks out real users.)

| Item | Quantity | Cost / month |
|---|---|---|
| HTTP API requests | 25.92 M | $25.92 |
| Lambda requests | 25.92 M | $5.18 |
| Lambda compute | 25.92 M × 0.02 s × 0.125 GB = 64,800 GB-s | $0.86 |
| DynamoDB reads | 1 RRU per check (the share lookup misses) | $3.24 |
| CloudWatch Logs | about 9 GB | $4.54 |
| **Total** | | **about $40** |

Whether API Gateway bills requests that it throttles or that fail the JWT authorizer was **not retrieved**; the table
assumes every request is billed. Ways to lower the ceiling without fixed-fee services: lower the stage rate, shorten
the log retention or log only errors, or remove the public route. A WAF would cost a fixed monthly fee and is
excluded.
