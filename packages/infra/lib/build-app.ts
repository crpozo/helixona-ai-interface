import * as cdk from 'aws-cdk-lib';
import { AppStack } from './app-stack.js';
import { AuthStack } from './auth-stack.js';
import { DeployConfig } from './config.js';
import { FoundationStack } from './foundation-stack.js';
import { NetworkStack } from './network-stack.js';
import { ObservabilityStack } from './observability-stack.js';

export interface HelixonaStacks {
  readonly foundation: FoundationStack;
  readonly auth: AuthStack;
  readonly network: NetworkStack;
  readonly app: AppStack;
  readonly observability: ObservabilityStack;
}

/** Instancia los cinco stacks con sus dependencias (usado por `bin/app.ts` y por los tests). */
export function buildStacks(app: cdk.App, config: DeployConfig, env: cdk.Environment): HelixonaStacks {
  const prefix = `Helixona-${config.stage}`;
  const tags = { Project: 'helixona-ai-interface', Stage: config.stage, DataClassification: 'PHI' };

  const foundation = new FoundationStack(app, `${prefix}-Foundation`, {
    env,
    config,
    tags,
    description: 'Helixona: KMS, DynamoDB, S3, secretos, ECR, Backup',
  });
  const auth = new AuthStack(app, `${prefix}-Auth`, {
    env,
    config,
    tags,
    phiKey: foundation.phiKey,
    description: 'Helixona: Cognito User Pool + WAF',
  });
  const network = new NetworkStack(app, `${prefix}-Network`, {
    env,
    config,
    tags,
    logsBucket: foundation.logsBucket,
    description: 'Helixona: VPC, subredes, endpoints, security groups',
  });
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
    anthropicApiKeySecret: foundation.anthropicApiKeySecret,
    apiRepository: foundation.apiRepository,
    userPool: auth.userPool,
    userPoolClient: auth.userPoolClient,
    cognitoDomainUrl: auth.cognitoDomainUrl,
    vpc: network.vpc,
    appSubnets: network.appSubnets,
    albSecurityGroup: network.albSecurityGroup,
    appSecurityGroup: network.appSecurityGroup,
  });
  const observability = new ObservabilityStack(app, `${prefix}-Observability`, {
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
  return { foundation, auth, network, app: appStack, observability };
}
