#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks, HIPAASecurityChecks } from 'cdk-nag';
import { AppStack } from '../lib/app-stack.js';
import { AuthStack } from '../lib/auth-stack.js';
import { loadConfig } from '../lib/config.js';
import { FoundationStack } from '../lib/foundation-stack.js';
import { NetworkStack } from '../lib/network-stack.js';
import { ObservabilityStack } from '../lib/observability-stack.js';

const app = new cdk.App();
const config = loadConfig(app);
const env: cdk.Environment = {
  account: process.env['CDK_DEFAULT_ACCOUNT'],
  region: process.env['CDK_DEFAULT_REGION'] ?? 'us-east-1',
};
const prefix = `Helixona-${config.stage}`;
const tags = { Project: 'helixona-ai-interface', Stage: config.stage, DataClassification: 'PHI' };

const foundation = new FoundationStack(app, `${prefix}-Foundation`, { env, config, tags, description: 'Helixona: KMS, DynamoDB, S3, secretos, ECR, Backup' });
const auth = new AuthStack(app, `${prefix}-Auth`, { env, config, tags, phiKey: foundation.phiKey, description: 'Helixona: Cognito User Pool + WAF' });
const network = new NetworkStack(app, `${prefix}-Network`, { env, config, tags, logsBucket: foundation.logsBucket, description: 'Helixona: VPC, subredes, endpoints, security groups' });
const appStack = new AppStack(app, `${prefix}-App`, {
  env,
  config,
  tags,
  description: 'Helixona: ECS Fargate, ALB, CloudFront, WAF',
  phiKey: foundation.phiKey,
  tables: foundation.tables,
  attachmentsBucket: foundation.attachmentsBucket,
  logsBucket: foundation.logsBucket,
  sessionSecret: foundation.sessionSecret,
  cognitoClientSecret: foundation.cognitoClientSecret,
  apiRepository: foundation.apiRepository,
  userPool: auth.userPool,
  userPoolClient: auth.userPoolClient,
  cognitoDomainUrl: auth.cognitoDomainUrl,
  vpc: network.vpc,
  appSubnets: network.appSubnets,
  albSecurityGroup: network.albSecurityGroup,
  appSecurityGroup: network.appSecurityGroup,
});
new ObservabilityStack(app, `${prefix}-Observability`, {
  env,
  config,
  tags,
  description: 'Helixona: alarmas, presupuesto, CloudTrail/Config opcionales',
  loadBalancer: appStack.loadBalancer,
  targetGroup: appStack.targetGroup,
  service: appStack.service,
  appLogGroup: appStack.appLogGroup,
  logsBucket: foundation.logsBucket,
  tables: Object.values(foundation.tables),
  attachmentsBucket: foundation.attachmentsBucket,
});

// cdk-nag: buenas prácticas AWS Solutions + controles HIPAA Security. Los errores bloquean el synth;
// cada supresión lleva justificación en el stack correspondiente.
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
cdk.Aspects.of(app).add(new HIPAASecurityChecks({ verbose: true }));

app.synth();
