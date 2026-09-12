import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { DeployConfig, resourceName } from './config.js';
import { addWafLogging, managedRule, rateLimitRule } from './waf.js';

export interface AuthStackProps extends cdk.StackProps {
  readonly config: DeployConfig;
  readonly phiKey: kms.IKey;
}

/**
 * Identidad: Cognito User Pool sin autoregistro, MFA TOTP obligatoria, app client confidencial
 * (Authorization Code) y WAF regional asociado al pool (sus endpoints son públicos).
 */
export class AuthStack extends cdk.Stack {
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
  readonly userPoolDomain: cognito.UserPoolDomain;
  /** `https://<prefijo>.auth.<region>.amazoncognito.com` (COGNITO_DOMAIN). */
  readonly cognitoDomainUrl: string;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);
    const { stage, appBaseUrl, cognitoDomainPrefix } = props.config;

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: resourceName(stage, 'users'),
      selfSignUpEnabled: false,
      signInAliases: { email: true, username: false },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
        fullname: { required: true, mutable: true },
      },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: cdk.Duration.days(3),
        passwordHistorySize: 12,
      },
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { sms: false, otp: true },
      featurePlan: cognito.FeaturePlan.PLUS,
      standardThreatProtectionMode: cognito.StandardThreatProtectionMode.FULL_FUNCTION,
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      deletionProtection: true,
      keepOriginal: { email: true },
      userInvitation: {
        emailSubject: 'Acceso a la interfaz clínica de IA',
        emailBody:
          'Hola {username}. Se ha creado tu cuenta en la interfaz clínica de IA. Tu contraseña temporal es {####}. ' +
          'Deberás cambiarla y configurar la app de autenticación en el primer acceso.',
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.userPool.addGroup('StaffGroup', { groupName: 'staff', description: 'Personal: usa el chat' });
    this.userPool.addGroup('AdminGroup', { groupName: 'admin', description: 'Administración: staff + gestión de usuarios y auditoría' });

    this.userPoolClient = this.userPool.addClient('WebClient', {
      userPoolClientName: resourceName(stage, 'web'),
      generateSecret: true,
      authFlows: { userSrp: false, userPassword: false, adminUserPassword: false, custom: false },
      oAuth: {
        flows: { authorizationCodeGrant: true, implicitCodeGrant: false, clientCredentials: false },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [`${appBaseUrl}/api/auth/callback`],
        logoutUrls: [`${appBaseUrl}/login`],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      accessTokenValidity: cdk.Duration.minutes(15),
      idTokenValidity: cdk.Duration.minutes(15),
      refreshTokenValidity: cdk.Duration.hours(12),
      enableTokenRevocation: true,
      preventUserExistenceErrors: true,
    });

    this.userPoolDomain = this.userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: cognitoDomainPrefix },
    });
    this.cognitoDomainUrl = `https://${cognitoDomainPrefix}.auth.${this.region}.amazoncognito.com`;

    // ---------------------------------------------------------------- WAF
    const webAcl = new wafv2.CfnWebACL(this, 'UserPoolWebAcl', {
      name: resourceName(stage, 'cognito'),
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: resourceName(stage, 'cognito') },
      rules: [
        managedRule('AWSManagedRulesCommonRuleSet', 10, 'AWSManagedRulesCommonRuleSet'),
        managedRule('AWSManagedRulesKnownBadInputsRuleSet', 20, 'AWSManagedRulesKnownBadInputsRuleSet'),
        managedRule('AWSManagedRulesAmazonIpReputationList', 30, 'AWSManagedRulesAmazonIpReputationList'),
        // Login/MFA: 300 req / 5 min por IP es holgado para humanos y frena fuerza bruta.
        rateLimitRule('RateLimitPerIp', 40, 300),
      ],
    });
    new wafv2.CfnWebACLAssociation(this, 'UserPoolWebAclAssociation', {
      resourceArn: this.userPool.userPoolArn,
      webAclArn: webAcl.attrArn,
    });
    addWafLogging(this, 'UserPoolWaf', {
      webAcl,
      logGroupName: `aws-waf-logs-${resourceName(stage, 'cognito')}`,
      encryptionKey: props.phiKey,
    });

    // ------------------------------------------------------------- Outputs
    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId, exportName: resourceName(stage, 'user-pool-id') });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId, exportName: resourceName(stage, 'user-pool-client-id') });
    new cdk.CfnOutput(this, 'CognitoDomain', { value: this.cognitoDomainUrl, exportName: resourceName(stage, 'cognito-domain') });
    new cdk.CfnOutput(this, 'FillClientSecretHint', {
      value:
        `aws cognito-idp describe-user-pool-client --user-pool-id ${this.userPool.userPoolId} ` +
        `--client-id ${this.userPoolClient.userPoolClientId} --query UserPoolClient.ClientSecret --output text`,
      description: 'Comando para obtener el client secret que hay que copiar en Secrets Manager (ver README)',
    });

  }
}
