# Environment configuration

The browser verifier and console do not load `.env` files or read environment variables at runtime. The optional root `.env.example` lists local test overrides that have defaults in the test/build tools. `FSEAL_BIN` selects a locally built CLI; `FSEAL_LARGE_PROBE` opts into a large-file browser probe. Set these in the invoking shell when needed.

An optional local n8n instance is separate from FlightSeal. Its example is [integrations/n8n/.env.example](../integrations/n8n/.env.example); copy it to `integrations/n8n/.env` only for a local n8n installation. It is loopback-only and does not install, start, or connect a workflow.
