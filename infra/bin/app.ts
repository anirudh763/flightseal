#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { RegistryStack } from '../lib/stack';

const app = new App();
// Environment-agnostic on purpose: synth needs no credentials and performs no lookups. Deploy to us-east-1.
new RegistryStack(app, 'HashWingRegistry', {
  pitr: app.node.tryGetContext('pitr') === true || app.node.tryGetContext('pitr') === 'true',
});
