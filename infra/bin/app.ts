#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { join } from 'node:path';
import { RegistryStack, restoreSettings, stackId } from '../lib/stack';

// `-c corsOrigins=a,b` arrives as a string, a cdk.json entry may be an array; anything else keeps the default.
function corsContext(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return value.split(',').map((o) => o.trim()).filter(Boolean);
  return undefined;
}

const app = new App();
// Environment-agnostic on purpose: synth needs no credentials and performs no lookups. Deploy to us-east-1.
// -c stage=prod for production (not authorized yet, see docs/aws/RUNBOOK_AWS.md). Any other value is refused.
const stage = app.node.tryGetContext('stage') ?? 'dev';
new RegistryStack(app, stackId(stage), {
  stage,
  pitr: app.node.tryGetContext('pitr') === true || app.node.tryGetContext('pitr') === 'true',
  // dev: -c restoredTableName/restoredFrom/restoreId. prod: infra/restore.json only (dist/bin -> infra).
  ...restoreSettings(stage, (k) => app.node.tryGetContext(k), join(__dirname, '..', '..', 'restore.json')),
  // -c corsOrigins=https://a.example,https://b.example (default: https://anirudh763.github.io)
  corsOrigins: corsContext(app.node.tryGetContext('corsOrigins')),
});
