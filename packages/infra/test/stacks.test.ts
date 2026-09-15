import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppStack } from '../lib/app-stack.js';
import { AuthStack } from '../lib/auth-stack.js';
import { loadConfig } from '../lib/config.js';
import { FoundationStack } from '../lib/foundation-stack.js';
import { NetworkStack } from '../lib/network-stack.js';

const env = { account: '123456789012', region: 'us-east-1' };

let foundation: Template;
let auth: Template;
let appT: Template;
let appStack: AppStack;

beforeAll(() => {
  const app = new cdk.App({ context: { stage: 'test', appBaseUrl: 'https://chat.test', cognitoDomainPrefix: 'helixona-test' } });
  const config = loadConfig(app);
  const f = new FoundationStack(app, 'F', { env, config });
  const a = new AuthStack(app, 'A', { env, config, phiKey: f.phiKey });
  const n = new NetworkStack(app, 'N', { env, config, logsBucket: f.logsBucket });
  appStack = new AppStack(app, 'App', {
    env,
    config,
    phiKey: f.phiKey,
    tables: f.tables,
    attachmentsBucket: f.attachmentsBucket,
    logsBucket: f.logsBucket,
    sessionSecret: f.sessionSecret,
    cognitoClientSecret: f.cognitoClientSecret,
    anthropicApiKeySecret: f.anthropicApiKeySecret,
    apiRepository: f.apiRepository,
    userPool: a.userPool,
    userPoolClient: a.userPoolClient,
    cognitoDomainUrl: a.cognitoDomainUrl,
    vpc: n.vpc,
    appSubnets: n.appSubnets,
    albSecurityGroup: n.albSecurityGroup,
    appSecurityGroup: n.appSecurityGroup,
  });
  foundation = Template.fromStack(f);
  auth = Template.fromStack(a);
  appT = Template.fromStack(appStack);
});

describe('FoundationStack', () => {
  it('crea las 6 tablas cifradas con la CMK, con PITR y protección de borrado', () => {
    const tables = foundation.findResources('AWS::DynamoDB::Table');
    expect(Object.keys(tables)).toHaveLength(6);
    const names = Object.values(tables).map((t) => (t as { Properties: { TableName: string } }).Properties.TableName).sort();
    expect(names).toEqual(['helixona-test-audit', 'helixona-test-conversations', 'helixona-test-messages', 'helixona-test-projects', 'helixona-test-sessions', 'helixona-test-usage']);
    foundation.allResourcesProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      SSESpecification: { SSEEnabled: true, SSEType: 'KMS', KMSMasterKeyId: Match.objectLike({ 'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('PhiDataKey')]) }) },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      DeletionProtectionEnabled: true,
    });
    foundation.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'helixona-test-audit',
      GlobalSecondaryIndexes: [Match.objectLike({ IndexName: 'byUser' })],
      TimeToLiveSpecification: Match.absent(),
    });
    foundation.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'helixona-test-conversations',
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    });
  });

  it('la CMK rota anualmente y deniega kms:Decrypt directo a quien no sea el rol de tarea', () => {
    foundation.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
      KeyPolicy: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'DenyDirectDecryptExceptTaskRole',
            Effect: 'Deny',
            Action: 'kms:Decrypt',
            Condition: Match.objectLike({ StringNotEquals: { 'aws:PrincipalArn': Match.objectLike({ 'Fn::Join': Match.anyValue() }) } }),
          }),
        ]),
      },
    });
    foundation.hasResourceProperties('AWS::KMS::Alias', { AliasName: 'alias/helixona-test-phi-data' });
  });

  it('el bucket de adjuntos usa SSE-KMS, bloquea acceso público y versiona', () => {
    foundation.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'helixona-test-attachments-123456789012',
      BucketEncryption: { ServerSideEncryptionConfiguration: [Match.objectLike({ ServerSideEncryptionByDefault: Match.objectLike({ SSEAlgorithm: 'aws:kms' }) })] },
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
      VersioningConfiguration: { Status: 'Enabled' },
      LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ NoncurrentVersionExpiration: { NoncurrentDays: 35 } })]) },
    });
  });

  it('crea los secretos SESSION_SECRET y COGNITO_CLIENT_SECRET', () => {
    foundation.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'helixona-test-session-secret', GenerateSecretString: Match.objectLike({ PasswordLength: 64 }) });
    foundation.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'helixona-test-cognito-client-secret' });
    foundation.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'helixona-test-anthropic-api-key' });
  });
});

describe('AuthStack', () => {
  it('User Pool con MFA OPTIONAL solo TOTP, sin autoregistro y contraseña fuerte', () => {
    auth.hasResourceProperties('AWS::Cognito::UserPool', {
      MfaConfiguration: 'OPTIONAL',
      EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
      AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }),
      UsernameAttributes: ['email'],
      DeletionProtection: 'ACTIVE',
      AccountRecoverySetting: { RecoveryMechanisms: [{ Name: 'verified_email', Priority: 1 }] },
      Policies: { PasswordPolicy: Match.objectLike({ MinimumLength: 12, RequireLowercase: true, RequireUppercase: true, RequireNumbers: true, RequireSymbols: true }) },
    });
    auth.resourceCountIs('AWS::Cognito::UserPoolGroup', 2);
  });

  it('app client confidencial con code grant, scopes y validez de tokens', () => {
    auth.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: true,
      AllowedOAuthFlows: ['code'],
      AllowedOAuthScopes: ['openid', 'email', 'profile'],
      CallbackURLs: ['https://chat.test/api/auth/callback'],
      LogoutURLs: ['https://chat.test/login'],
      AccessTokenValidity: 15,
      IdTokenValidity: 15,
      RefreshTokenValidity: 720, // 12 h expresadas en minutos
      TokenValidityUnits: { AccessToken: 'minutes', IdToken: 'minutes', RefreshToken: 'minutes' },
    });
  });

  it('WAF regional asociado al User Pool con logging redactado', () => {
    auth.hasResourceProperties('AWS::WAFv2::WebACL', { Scope: 'REGIONAL' });
    auth.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
    auth.hasResourceProperties('AWS::WAFv2::LoggingConfiguration', {
      RedactedFields: [{ SingleHeader: { Name: 'authorization' } }, { SingleHeader: { Name: 'cookie' } }],
    });
  });
});

describe('AppStack', () => {
  it('servicio Fargate sin IP pública, sin ECS Exec y en subredes privadas', () => {
    appT.hasResourceProperties('AWS::ECS::Service', {
      LaunchType: 'FARGATE',
      EnableExecuteCommand: false,
      NetworkConfiguration: { AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: 'DISABLED' }) },
    });
    appT.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '512',
      Memory: '1024',
      RequiresCompatibilities: ['FARGATE'],
      ContainerDefinitions: [
        Match.objectLike({
          // arrayWith exige el mismo orden relativo que en la plantilla
          Environment: Match.arrayWith([
            { Name: 'AUTH_MODE', Value: 'cognito' },
            { Name: 'STORE_MODE', Value: 'dynamo' },
            { Name: 'LLM_MODE', Value: 'anthropic' },
          ]),
          Secrets: Match.arrayWith([Match.objectLike({ Name: 'SESSION_SECRET' }), Match.objectLike({ Name: 'COGNITO_CLIENT_SECRET' }), Match.objectLike({ Name: 'ANTHROPIC_API_KEY' })]),
        }),
      ],
    });
  });

  it('la política del rol de tarea no permite Update/Delete sobre la tabla audit', () => {
    const policies = appT.findResources('AWS::IAM::Policy', {
      Properties: { Roles: [{ Ref: Match.stringLikeRegexp('TaskRole') }] },
    });
    expect(Object.keys(policies).length).toBeGreaterThan(0);
    const statements = Object.values(policies).flatMap(
      (p) => (p as { Properties: { PolicyDocument: { Statement: Array<{ Effect: string; Action: string | string[]; Resource: unknown }> } } }).Properties.PolicyDocument.Statement,
    );
    const mentionsAudit = (r: unknown): boolean => JSON.stringify(r).includes('AuditTable');
    const allowsOnAudit = statements.filter((s) => s.Effect === 'Allow' && mentionsAudit(s.Resource)).flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    expect(allowsOnAudit.length).toBeGreaterThan(0);
    expect(allowsOnAudit).not.toContain('dynamodb:UpdateItem');
    expect(allowsOnAudit).not.toContain('dynamodb:DeleteItem');
    expect(allowsOnAudit).not.toContain('dynamodb:BatchWriteItem');
    expect(allowsOnAudit).not.toContain('dynamodb:*');
    const denies = statements.filter((s) => s.Effect === 'Deny' && mentionsAudit(s.Resource));
    expect(denies.some((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]).includes('dynamodb:DeleteItem'))).toBe(true);
    appT.hasResourceProperties('AWS::IAM::Role', { RoleName: 'helixona-test-task-role' });
  });

  it('ALB con idle timeout 600 s, health check /api/health y 403 por defecto', () => {
    appT.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      LoadBalancerAttributes: Match.arrayWith([
        { Key: 'idle_timeout.timeout_seconds', Value: '600' },
        { Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' },
        { Key: 'access_logs.s3.enabled', Value: 'true' },
      ]),
    });
    appT.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', { HealthCheckPath: '/api/health', Port: 3000, Protocol: 'HTTP', TargetType: 'ip' });
    appT.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      DefaultActions: [Match.objectLike({ Type: 'fixed-response', FixedResponseConfig: Match.objectLike({ StatusCode: '403' }) })],
    });
    appT.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Conditions: [{ Field: 'http-header', HttpHeaderConfig: Match.objectLike({ HttpHeaderName: 'X-Origin-Verify' }) }],
    });
  });

  it('CloudFront con WAF, timeouts de origen 60 s, cabecera secreta y caché deshabilitada en /api/*', () => {
    appT.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        PriceClass: 'PriceClass_100',
        WebACLId: Match.anyValue(),
        Logging: Match.objectLike({ IncludeCookies: false }),
        Origins: [
          Match.objectLike({
            CustomOriginConfig: Match.objectLike({ OriginReadTimeout: 60, OriginKeepaliveTimeout: 60 }),
            OriginCustomHeaders: [Match.objectLike({ HeaderName: 'X-Origin-Verify' })],
          }),
        ],
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({ PathPattern: '/api/*', CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad', ViewerProtocolPolicy: 'redirect-to-https' }),
        ]),
      }),
    });
    appT.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'CLOUDFRONT',
      Rules: Match.arrayWith([Match.objectLike({ Statement: { RateBasedStatement: Match.objectLike({ Limit: 3000 }) } })]),
    });
  });
});
