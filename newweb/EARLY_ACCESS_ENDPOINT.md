# Optional early access endpoint

The public build has no endpoint configured. The Team & Cloud form saves an explicitly submitted local draft in `flightseal_early_access_draft_v1`; it does not enroll or send anything.

To configure a prospective endpoint for a local build, set `VITE_HASHWING_EARLY_ACCESS_ENDPOINT` to an HTTPS POST URL and rebuild. `localhost` HTTP is allowed for an owned local test receiver. The build adds only that endpoint's origin to `connect-src`; no secret belongs in this value or the static bundle.

The endpoint receives JSON containing only `email`, `teamSize`, and `useCase`. It should return a successful HTTP response with JSON `{ "received": true }` only after it has accepted the request. HashWing shows “Request received” only for that exact acknowledgement. A network failure is never queued for background retry. No receiver or production waitlist is provisioned by this repository.
