#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { RegistryStack } from '../lib/stack';

// `-c corsOrigins=a,b` arrives as a string, a cdk.json entry may be an array; anything else keeps the default.
function corsContext(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return value.split(',').map((o) => o.trim()).filter(Boolean);
  return undefined;
}

const app = new App();
// Environment-agnostic on purpose: synth needs no credentials and performs no lookups. Deploy to us-east-1.
new RegistryStack(app, 'HashWingRegistry', {
  pitr: app.node.tryGetContext('pitr') === true || app.node.tryGetContext('pitr') === 'true',
  restoredTableName: app.node.tryGetContext('restoredTableName'),
  restoredFrom: app.node.tryGetContext('restoredFrom'),
  restoreId: app.node.tryGetContext('restoreId'),
  // -c corsOrigins=https://a.example,https://b.example (default: https://anirudh763.github.io)
  corsOrigins: corsContext(app.node.tryGetContext('corsOrigins')),
});
