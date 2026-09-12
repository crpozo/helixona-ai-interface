#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks, HIPAASecurityChecks } from 'cdk-nag';
import { buildStacks } from '../lib/build-app.js';
import { loadConfig } from '../lib/config.js';

const app = new cdk.App();
const config = loadConfig(app);
const env: cdk.Environment = {
  account: process.env['CDK_DEFAULT_ACCOUNT'],
  region: process.env['CDK_DEFAULT_REGION'] ?? 'us-east-1',
};

buildStacks(app, config, env);

// cdk-nag: buenas prácticas AWS Solutions + controles HIPAA Security. Los errores bloquean el synth;
// cada supresión lleva su justificación en el stack correspondiente.
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
cdk.Aspects.of(app).add(new HIPAASecurityChecks({ verbose: true }));

app.synth();
