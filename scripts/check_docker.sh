#!/usr/bin/env bash
set -euo pipefail
repo_dir=$(cd "$(dirname "$0")/.." && pwd)
docker build --target verification --tag flightseal-verified:local "$repo_dir"
