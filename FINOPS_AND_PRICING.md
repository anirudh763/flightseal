# FinOps and pricing hypotheses

## Current cost and readiness

The present verifier is static and local-first; the public GitHub Pages site exists, but it is not a guarantee of
unlimited free hosting or a private cloud backend. Native CLI and browser/WASM verification consume the user's own
device. No AWS account or backend is configured, and this work creates no cloud resources or billable commitment.
The React console is implemented and has no validated customer demand or operating-cost history.

## Optional AWS cost model

No fixed per-flight or per-million-job COGS is supportable until workload, retention, region, and observed usage are
known. For a workload with `F` flights/month, average uploaded log `B` bytes, receipt object size `R`, per-flight
object batch size `Q`, retention `D` days, and average stored copies `C`, estimate monthly cost as:

```text
storage       = (F × (B + R) × D / 30 × C in GB-month) × S3 rate by storage class/region
PUT requests  = ceil(F × (1 + 1/Q)) × S3 PUT rate
GET requests  = reads × S3 GET rate; include LIST/metadata reads separately
KMS           = key monthly charge × key count + signing requests × Sign rate + decrypt/encrypt requests × rate
Lambda        = invocations × request rate + GB-seconds × duration rate + ephemeral storage beyond allowance
Athena        = compressed/query-scanned bytes × query rate; manifests should keep scans small
backup/replica= replicated bytes + destination storage, requests, retrieval and any cross-region transfer
egress        = bytes returned to users/investigators × applicable internet/region rate
total         = storage + requests + KMS + Lambda + Athena + backup/replica + egress + monitoring/log retention
```

`Q` only reduces object/request overhead if the product batches objects; it does not reduce the log bytes. Receipt
cadence controls how much data is left uncovered, so do not increase `Q` solely to improve unit economics. Include
failed/retried jobs, temporary copies, lifecycle transitions/retrieval, KMS key count, and retained Lambda logs in
any estimate. Use the official [S3 pricing page](https://aws.amazon.com/s3/pricing/), [KMS pricing](https://aws.amazon.com/kms/pricing/),
[Lambda pricing](https://aws.amazon.com/lambda/pricing/), and [Athena pricing](https://aws.amazon.com/athena/pricing/)
for the selected region and storage/query settings at quote time. Rates and free-tier terms change; this document
does not claim a live quote. QLDB is retired (July 31, 2025) and is not a proposed dependency ([AWS shutdown notice](https://docs.aws.amazon.com/general/latest/gr/full_shutdown_services.html)).

## Price hypotheses, not offers

Potential experiments are a free local verifier and a team tier priced at **$49/month** or **$299/month**. These are
unvalidated price hypotheses only: there are no validated user counts, sales, conversion measurements, checkout, margin figures, or support
cost measurements. Do not publish these as available plans or forecast revenue until user interviews, workload
costs, support burden, and a working privacy-safe billing flow justify them. No email collection or outreach has
been performed as part of this work.

## Cost guardrails for a future pilot

- Keep the initial workflow local and use static hosting where appropriate; static pages do not imply free storage,
  signing, upload, or compute services.
- If an AWS pilot is later approved, set a region, budgets/alerts, retention limits, request and size caps, and a
  shutdown path before enabling uploads. Separate telemetry metadata from flight payloads and keep payloads out of
  analytics and logs.
- Measure actual workload dimensions first: bytes per flight, objects per flight, receipt cadence, reads per flight,
  retention days, backup copies, verification duration/memory, and egress. Publish estimates with assumptions and a
  rate-check date. No $0.15 per million, 95% margin, or other unmeasured unit-cost claim is made here.

## AWS Amplify estimate boundary

The local deployment manifest does not create an AWS account or resource. Amplify pricing and free-tier eligibility
are account-dependent: verify [current Amplify pricing](https://aws.amazon.com/amplify/pricing/) before deployment.
Outside any eligible allowance, the published standard build, storage, and data-transfer rates checked on
2026-11-14 are $0.01/build-minute, $0.023/GB-month stored, and $0.15/GB served. These do not include a private
archive, database, signer, media conversion backend, backups or tax. No overall enforced spending cap was verified.

For example, 10,000 sessions each downloading 3 MiB transfer about 29.3 GiB before repeat caching; an optional
full PX4 download adds 28.9 MiB per request. Estimate storage/build and transfer separately using the provider
GB accounting, free allowance, cache hit rate and actual measured bundle size. This is a workload estimate, not
proof of $0 hosting at unlimited traffic. The current authorized choice remains existing $0 demos.

The console's Team options dialog labels $49/month as proposed and unavailable. Its feedback link opens a public
GitHub issue form at the user's choice; the application sends no email, creates no issue automatically, and collects
no work email address. A real private waitlist requires a separately configured endpoint and privacy notice.
