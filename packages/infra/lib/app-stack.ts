import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { CATALOG_MODEL_IDS, DeployConfig, resourceName, taskRoleName } from './config.js';
import type { HelixonaTables } from './foundation-stack.js';
import { addWafLogging, managedRule, rateLimitRule } from './waf.js';

export interface AppStackProps extends cdk.StackProps {
  readonly config: DeployConfig;
  readonly phiKey: kms.IKey;
  readonly tables: HelixonaTables;
  readonly attachmentsBucket: s3.IBucket;
  readonly logsBucket: s3.IBucket;
  readonly sessionSecret: secretsmanager.ISecret;
  readonly cognitoClientSecret: secretsmanager.ISecret;
  readonly apiRepository: ecr.IRepository;
  readonly userPool: cognito.IUserPool;
  readonly userPoolClient: cognito.IUserPoolClient;
  readonly cognitoDomainUrl: string;
  readonly vpc: ec2.IVpc;
  readonly appSubnets: ec2.SubnetSelection;
  readonly albSecurityGroup: ec2.ISecurityGroup;
  readonly appSecurityGroup: ec2.ISecurityGroup;
}

const ORIGIN_VERIFY_HEADER = 'X-Origin-Verify';

/**
 * Cómputo y borde: ECS Fargate (un contenedor Node que sirve API + SPA), ALB, CloudFront + WAF.
 */
export class AppStack extends cdk.Stack {
  readonly cluster: ecs.Cluster;
  readonly service: ecs.FargateService;
  readonly taskRole: iam.Role;
  readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  readonly targetGroup: elbv2.ApplicationTargetGroup;
  readonly distribution: cloudfront.Distribution;
  readonly appLogGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const cfg = props.config;
    const { stage } = cfg;

    // El WebACL de CloudFront (scope CLOUDFRONT) y su logging solo pueden crearse en us-east-1.
    // Desplegar la app en otra región requeriría un stack aparte en us-east-1 (crossRegionReferences).
    if (!cdk.Token.isUnresolved(this.region) && this.region !== 'us-east-1') {
      throw new Error(`AppStack debe desplegarse en us-east-1 (WAF de CloudFront); región actual: ${this.region}`);
    }

    // --------------------------------------------------------------- Logs
    this.appLogGroup = new logs.LogGroup(this, 'AppLogGroup', {
      logGroupName: `/helixona/${stage}/api`,
      retention: logs.RetentionDays.ONE_YEAR,
      encryptionKey: props.phiKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // --------------------------------------------------------- IAM (tarea)
    // Nombre fijo: la política de la CMK (FoundationStack) deniega `kms:Decrypt` a todo lo que no sea este rol.
    this.taskRole = new iam.Role(this, 'TaskRole', {
      roleName: taskRoleName(stage),
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Rol de la tarea Fargate de la API (mínimo privilegio, §8 del contrato)',
    });
    this.attachTaskPolicies(props);

    const executionRole = new iam.Role(this, 'ExecutionRole', {
      roleName: resourceName(stage, 'exec-role'),
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Rol de ejecución ECS: pull de ECR, secretos y logs',
    });
    props.apiRepository.grantPull(executionRole);
    this.appLogGroup.grantWrite(executionRole);
    // Descifrado de secretos e imágenes vía servicio (el key policy de la CMK confía en IAM de la cuenta).
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DecryptSecretsAndImagesViaService',
        actions: ['kms:Decrypt'],
        resources: [props.phiKey.keyArn],
        conditions: { StringEquals: { 'kms:ViaService': [`secretsmanager.${this.region}.amazonaws.com`, `ecr.${this.region}.amazonaws.com`] } },
      }),
    );

    // ----------------------------------------------------------------- ECS
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: resourceName(stage, 'cluster'),
      vpc: props.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENHANCED,
      enableFargateCapacityProviders: true,
    });

    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      family: resourceName(stage, 'api'),
      cpu: 512,
      memoryLimitMiB: 1024,
      taskRole: this.taskRole,
      executionRole,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });

    // Los secretos se importan por ARN completo (sin clave KMS asociada): así el `grantRead` que hace
    // la definición del contenedor sobre el rol de ejecución no toca el key policy de la CMK
    // (FoundationStack), lo que crearía un ciclo Foundation <-> App. El descifrado vía Secrets
    // Manager se concede explícitamente al rol de ejecución (más arriba).
    const sessionSecretRef = secretsmanager.Secret.fromSecretCompleteArn(this, 'SessionSecretRef', props.sessionSecret.secretArn);
    const cognitoClientSecretRef = secretsmanager.Secret.fromSecretCompleteArn(this, 'CognitoClientSecretRef', props.cognitoClientSecret.secretArn);

    const containerPort = 3000;
    const containerProtocol = cfg.tlsToContainer ? 'https' : 'http';
    const tableNames = props.tables;
    const container = taskDef.addContainer('api', {
      containerName: 'api',
      // Imagen construida por CI (deploy.yml) y publicada en el ECR de FoundationStack.
      // `ContainerImage.fromAsset(<raíz del monorepo>, { file: 'packages/api/Dockerfile' })` sería la
      // alternativa, pero exige Docker en el synth y hashear el monorepo completo.
      image: ecs.ContainerImage.fromEcrRepository(props.apiRepository, cfg.imageTag),
      essential: true,
      readonlyRootFilesystem: true,
      user: '1000:1000',
      portMappings: [{ containerPort, protocol: ecs.Protocol.TCP, name: 'http' }],
      logging: ecs.LogDrivers.awsLogs({ logGroup: this.appLogGroup, streamPrefix: 'api', mode: ecs.AwsLogDriverMode.NON_BLOCKING }),
      healthCheck: {
        // Sin curl en imágenes distroless: el contenedor expone /api/health y Node hace la sonda.
        command: ['CMD-SHELL', `node -e "fetch('${containerProtocol}://127.0.0.1:${containerPort}/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(30),
      },
      environment: {
        NODE_ENV: 'production',
        PORT: String(containerPort),
        APP_BASE_URL: cfg.appBaseUrl,
        AUTH_MODE: 'cognito',
        COGNITO_REGION: this.region,
        COGNITO_USER_POOL_ID: props.userPool.userPoolId,
        COGNITO_CLIENT_ID: props.userPoolClient.userPoolClientId,
        COGNITO_DOMAIN: props.cognitoDomainUrl,
        SESSION_IDLE_SECONDS: '900',
        SESSION_ABSOLUTE_SECONDS: '43200',
        STORE_MODE: 'dynamo',
        TABLE_CONVERSATIONS: tableNames.conversations.tableName,
        TABLE_MESSAGES: tableNames.messages.tableName,
        TABLE_SESSIONS: tableNames.sessions.tableName,
        TABLE_AUDIT: tableNames.audit.tableName,
        TABLE_USAGE: tableNames.usage.tableName,
        AWS_REGION: this.region,
        LLM_MODE: 'bedrock',
        EFFORT: 'medium',
        MAX_TOKENS: '64000',
        THINKING_DISPLAY: 'omitted',
        CONTEXT_LIMIT_TOKENS: '150000',
        DAILY_QUOTA_USD: '10',
        RETENTION_DAYS: String(cfg.retentionDays),
        FIRST_EVENT_TIMEOUT_MS: '60000',
        LLM_TIMEOUT_MS: '600000',
        LOG_LEVEL: 'info',
        ATTACHMENTS_BUCKET: props.attachmentsBucket.bucketName,
        TLS_TO_CONTAINER: String(cfg.tlsToContainer),
      },
      secrets: {
        SESSION_SECRET: ecs.Secret.fromSecretsManager(sessionSecretRef),
        COGNITO_CLIENT_SECRET: ecs.Secret.fromSecretsManager(cognitoClientSecretRef),
      },
    });
    // Sistema de archivos de solo lectura: /tmp escribible para Node.
    taskDef.addVolume({ name: 'tmp' });
    container.addMountPoints({ containerPath: '/tmp', sourceVolume: 'tmp', readOnly: false });

    this.service = new ecs.FargateService(this, 'Service', {
      serviceName: resourceName(stage, 'api'),
      cluster: this.cluster,
      taskDefinition: taskDef,
      desiredCount: cfg.desiredCount,
      assignPublicIp: false,
      enableExecuteCommand: false,
      vpcSubnets: props.appSubnets,
      securityGroups: [props.appSecurityGroup],
      platformVersion: ecs.FargatePlatformVersion.LATEST,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: { enable: true, rollback: true },
      healthCheckGracePeriod: cdk.Duration.seconds(60),
      propagateTags: ecs.PropagatedTagSource.SERVICE,
    });
    const scaling = this.service.autoScaleTaskCount({ minCapacity: 1, maxCapacity: 3 });
    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 60,
      scaleInCooldown: cdk.Duration.minutes(5),
      scaleOutCooldown: cdk.Duration.minutes(2),
    });

    // ----------------------------------------------------------------- ALB
    // Secreto compartido CloudFront → ALB: solo pasa el tráfico con la cabecera correcta.
    const originVerifySecret = new secretsmanager.Secret(this, 'OriginVerifySecret', {
      secretName: resourceName(stage, 'origin-verify'),
      description: `Valor de la cabecera ${ORIGIN_VERIFY_HEADER} entre CloudFront y el ALB`,
      encryptionKey: props.phiKey,
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });
    // Referencia dinámica `{{resolve:secretsmanager:...}}`: CloudFormation la resuelve al desplegar
    // (no queda en la plantilla). Rotar = cambiar el secreto y redesplegar AppStack.
    const originVerifyValue = originVerifySecret.secretValue.unsafeUnwrap();

    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      loadBalancerName: resourceName(stage, 'alb'),
      vpc: props.vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: props.albSecurityGroup,
      idleTimeout: cdk.Duration.seconds(600),
      dropInvalidHeaderFields: true,
      http2Enabled: true,
      deletionProtection: true,
    });
    this.loadBalancer.logAccessLogs(props.logsBucket, `alb/${stage}`);

    // TODO(TLS hasta el contenedor): con `tlsToContainer=true` el contenedor sirve HTTPS en 3000
    // con certificado autofirmado y el target group habla HTTPS (el ALB no valida la cadena).
    const targetProtocol = cfg.tlsToContainer ? elbv2.ApplicationProtocol.HTTPS : elbv2.ApplicationProtocol.HTTP;
    this.targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      targetGroupName: resourceName(stage, 'api'),
      vpc: props.vpc,
      port: containerPort,
      protocol: targetProtocol,
      protocolVersion: elbv2.ApplicationProtocolVersion.HTTP1,
      targetType: elbv2.TargetType.IP,
      deregistrationDelay: cdk.Duration.seconds(30),
      healthCheck: {
        path: '/api/health',
        protocol: cfg.tlsToContainer ? elbv2.Protocol.HTTPS : elbv2.Protocol.HTTP,
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });
    this.targetGroup.addTarget(this.service);

    let listener: elbv2.ApplicationListener;
    if (cfg.certificateArn) {
      listener = this.loadBalancer.addListener('Https', {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [elbv2.ListenerCertificate.fromArn(cfg.certificateArn)],
        sslPolicy: elbv2.SslPolicy.TLS13_RES,
        open: false,
        defaultAction: elbv2.ListenerAction.fixedResponse(403, { contentType: 'application/json', messageBody: '{"error":{"code":"forbidden","message":"forbidden"}}' }),
      });
    } else {
      // Sin certificado ACM (contexto `certificateArn`): listener HTTP 80 SOLO para entornos de
      // desarrollo sin PHI. CloudFront sigue sirviendo HTTPS al navegador, pero el tramo
      // CloudFront→ALB va en claro. En producción `certificateArn` es obligatorio.
      cdk.Annotations.of(this).addWarningV2(
        'helixona:no-certificate',
        'Sin `certificateArn`: el ALB escucha en HTTP 80. No apto para PHI.',
      );
      listener = this.loadBalancer.addListener('Http', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        open: false,
        defaultAction: elbv2.ListenerAction.fixedResponse(403, { contentType: 'application/json', messageBody: '{"error":{"code":"forbidden","message":"forbidden"}}' }),
      });
    }
    listener.addAction('OriginVerified', {
      priority: 10,
      conditions: [elbv2.ListenerCondition.httpHeader(ORIGIN_VERIFY_HEADER, [originVerifyValue])],
      action: elbv2.ListenerAction.forward([this.targetGroup]),
    });

    // ---------------------------------------------------------------- WAF
    const chatPathScope: wafv2.CfnWebACL.StatementProperty = {
      byteMatchStatement: {
        fieldToMatch: { uriPath: {} },
        positionalConstraint: 'STARTS_WITH',
        searchString: '/api/conversations',
        textTransformations: [{ priority: 0, type: 'NONE' }],
      },
    };
    const cfWebAcl = new wafv2.CfnWebACL(this, 'CloudFrontWebAcl', {
      name: resourceName(stage, 'edge'),
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: resourceName(stage, 'edge') },
      rules: [
        // Rate limit alto por IP: una clínica detrás de NAT comparte IP; 3000 req / 5 min.
        rateLimitRule('RateLimitPerIp', 10, 3000),
        managedRule('AWSManagedRulesAmazonIpReputationList', 20, 'AWSManagedRulesAmazonIpReputationList'),
        managedRule('AWSManagedRulesKnownBadInputsRuleSet', 30, 'AWSManagedRulesKnownBadInputsRuleSet'),
        // Core Rule Set: bloquea en todo el sitio EXCEPTO bajo `/api/conversations*` (texto clínico
        // libre = falsos positivos). El contrato pide "modo count" en esa ruta; se implementa como
        // exclusión por scope-down porque (a) un mismo rule group no puede referenciarse dos veces en
        // un WebACL con scope-downs distintos y (b) `count` seguiría escribiendo el fragmento
        // coincidente (potencial PHI) en el log de WAF. En esa ruta siguen activos el rate limit,
        // KnownBadInputs e IP reputation.
        managedRule('AWSManagedRulesCommonRuleSet', 40, 'AWSManagedRulesCommonRuleSet', {
          scopeDown: { notStatement: { statement: chatPathScope } },
        }),
      ],
    });
    addWafLogging(this, 'CloudFrontWaf', {
      webAcl: cfWebAcl,
      logGroupName: `aws-waf-logs-${resourceName(stage, 'edge')}`,
      encryptionKey: props.phiKey,
    });

    // ---------------------------------------------------------- CloudFront
    const originProtocol = cfg.certificateArn ? cloudfront.OriginProtocolPolicy.HTTPS_ONLY : cloudfront.OriginProtocolPolicy.HTTP_ONLY;
    const albOrigin = new origins.LoadBalancerV2Origin(this.loadBalancer, {
      protocolPolicy: originProtocol,
      httpPort: 80,
      httpsPort: 443,
      originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
      // SSE con heartbeats cada 15 s: 60 s de lectura es suficiente margen.
      readTimeout: cdk.Duration.seconds(60),
      keepaliveTimeout: cdk.Duration.seconds(60),
      customHeaders: { [ORIGIN_VERIFY_HEADER]: originVerifyValue },
    });
    const cfCertArn = cfg.cloudFrontCertificateArn ?? cfg.certificateArn;
    const cfCertificate = cfg.domainName && cfCertArn ? acm.Certificate.fromCertificateArn(this, 'CfCertificate', cfCertArn) : undefined;
    if (cfg.domainName && !cfCertArn) {
      throw new Error('`domainName` requiere `certificateArn` o `cloudFrontCertificateArn` (ACM en us-east-1)');
    }

    const apiBehavior: cloudfront.BehaviorOptions = {
      origin: albOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      // Reenvía cookies, cabeceras y query al origen (sesión, CSRF, Host).
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      compress: false, // SSE: sin buffering por compresión
    };

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `Helixona ${stage}: interfaz Claude/Bedrock de la clínica`,
      ...(cfg.domainName && cfCertificate ? { domainNames: [cfg.domainName], certificate: cfCertificate } : {}),
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      sslSupportMethod: cloudfront.SSLMethod.SNI,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // Norteamérica + Europa (documentado: TLS termina en POPs)
      webAclId: cfWebAcl.attrArn,
      enableLogging: true,
      logBucket: props.logsBucket,
      logFilePrefix: `cloudfront/${stage}/`,
      logIncludesCookies: false,
      ...(cfg.geoAllowCountries.length > 0 ? { geoRestriction: cloudfront.GeoRestriction.allowlist(...cfg.geoAllowCountries) } : {}),
      defaultBehavior: {
        origin: albOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        compress: true,
      },
      additionalBehaviors: {
        '/api/*': apiBehavior,
        // La SPA (index.html) no debe cachearse: siempre al origen.
        '/': { ...apiBehavior, allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS, compress: true },
        '/index.html': { ...apiBehavior, allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS, compress: true },
        '/login': { ...apiBehavior, allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS, compress: true },
      },
    });

    // ------------------------------------------------------------- Outputs
    new cdk.CfnOutput(this, 'DistributionDomainName', { value: this.distribution.distributionDomainName });
    new cdk.CfnOutput(this, 'LoadBalancerDnsName', { value: this.loadBalancer.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'ClusterName', { value: this.cluster.clusterName });
    new cdk.CfnOutput(this, 'ServiceName', { value: this.service.serviceName });
    new cdk.CfnOutput(this, 'TaskRoleArn', { value: this.taskRole.roleArn });

    this.addNagSuppressions(cfg, originVerifySecret);
  }

  /** Política mínima del rol de tarea (§8 del contrato). */
  private attachTaskPolicies(props: AppStackProps): void {
    const { tables } = props;
    const region = this.region;
    const account = this.account;
    const partition = this.partition;

    // Bedrock: solo los modelos del catálogo (§6) y los perfiles de inferencia `us.` de Anthropic.
    // Los perfiles cross-region `us.` enrutan a otras regiones de EE.UU.: hacen falta también los
    // ARNs de foundation-model en esas regiones (`us-*`).
    const modelArns = CATALOG_MODEL_IDS.flatMap((modelId) => [
      `arn:${partition}:bedrock:${region}::foundation-model/${modelId}`,
      `arn:${partition}:bedrock:us-*::foundation-model/${modelId}`,
    ]);
    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'BedrockInvokeCatalogModels',
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          ...modelArns,
          // TODO(Mantle): a verificar para el endpoint Mantle (`bedrock-mantle`): si expone otras
          // acciones IAM o ARNs distintos (p. ej. `bedrock:InvokeModel*` sobre perfiles propios).
          `arn:${partition}:bedrock:${region}:${account}:inference-profile/us.anthropic.*`,
        ],
      }),
    );

    const rwActions = [
      'dynamodb:GetItem',
      'dynamodb:BatchGetItem',
      'dynamodb:Query',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      'dynamodb:DeleteItem',
      'dynamodb:BatchWriteItem',
      'dynamodb:ConditionCheckItem',
      'dynamodb:DescribeTable',
    ];
    const withIndexes = (t: { tableArn: string }) => [t.tableArn, `${t.tableArn}/index/*`];
    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DynamoDbAppTables',
        actions: rwActions,
        resources: [tables.conversations, tables.messages, tables.sessions, tables.usage].flatMap(withIndexes),
      }),
    );
    // Audit: solo escribir y consultar. Además Deny explícito de Update/Delete (append-only).
    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DynamoDbAuditAppendOnly',
        actions: ['dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:DescribeTable'],
        resources: withIndexes(tables.audit),
      }),
    );
    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DenyAuditMutation',
        effect: iam.Effect.DENY,
        actions: ['dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:BatchWriteItem', 'dynamodb:DeleteTable'],
        resources: withIndexes(tables.audit),
      }),
    );

    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'KmsPhiKey',
        actions: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
        resources: [props.phiKey.keyArn],
      }),
    );

    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CognitoUserAdmin',
        actions: [
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminDisableUser',
          'cognito-idp:AdminEnableUser',
          'cognito-idp:AdminGetUser',
          'cognito-idp:AdminAddUserToGroup',
          'cognito-idp:AdminListGroupsForUser',
          'cognito-idp:ListUsers',
          'cognito-idp:AdminUserGlobalSignOut',
          'cognito-idp:AdminRevokeToken',
          'cognito-idp:RevokeToken',
        ],
        resources: [props.userPool.userPoolArn],
      }),
    );

    // Adjuntos (fase 2): solo objetos del bucket propio.
    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AttachmentsObjects',
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        resources: [props.attachmentsBucket.arnForObjects('*')],
      }),
    );

    this.appLogGroup.grantWrite(this.taskRole);
  }

  private addNagSuppressions(cfg: DeployConfig, originVerifySecret: secretsmanager.Secret): void {
    NagSuppressions.addResourceSuppressions(
      this.taskRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Comodines acotados: índices GSI de las tablas propias, objetos del bucket de adjuntos, foundation-models del catálogo en regiones us-* (perfiles cross-region) y perfiles de inferencia us.anthropic.*.',
        },
        { id: 'HIPAA.Security-IAMNoInlinePolicy', reason: 'Política inline generada por CDK, ligada exclusivamente a este rol (no reutilizable), con permisos enumerados por recurso.' },
      ],
      true,
    );
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `/${this.stackName}/ExecutionRole`,
      [
        { id: 'AwsSolutions-IAM5', reason: 'ecr:GetAuthorizationToken solo admite Resource "*"; el resto se acota al repositorio, los dos secretos y el log group.' },
        { id: 'HIPAA.Security-IAMNoInlinePolicy', reason: 'Política inline generada por CDK ligada solo al rol de ejecución de ECS.' },
      ],
      true,
    );
    NagSuppressions.addResourceSuppressions(
      this.service,
      [{ id: 'HIPAA.Security-IAMNoInlinePolicy', reason: 'Política de autoscaling generada por CDK, ligada solo al rol de Application Auto Scaling.' }],
      true,
    );
    NagSuppressions.addResourceSuppressions(
      this.service.taskDefinition,
      [
        {
          id: 'AwsSolutions-ECS2',
          reason: 'Las variables de entorno son configuración no secreta (modos, nombres de tablas, IDs de Cognito). Los secretos van por Secrets Manager (`secrets`).',
        },
      ],
      true,
    );
    NagSuppressions.addResourceSuppressions(originVerifySecret, [
      { id: 'AwsSolutions-SMG4', reason: 'Rotación coordinada manual: cambiar el valor y redesplegar AppStack (listener + cabecera de CloudFront).' },
      { id: 'HIPAA.Security-SecretsManagerRotationEnabled', reason: 'Rotación coordinada manual (ver README); no es una credencial de acceso a datos.' },
    ]);
    if (!cfg.certificateArn) {
      NagSuppressions.addResourceSuppressions(
        this.loadBalancer,
        [
          { id: 'AwsSolutions-ELB2', reason: 'Access logs habilitados vía logAccessLogs (la regla no lo detecta cuando el bucket es de otro stack).' },
          { id: 'HIPAA.Security-ALBHttpToHttpsRedirection', reason: 'Sin `certificateArn` (solo dev sin PHI) no hay listener HTTPS al que redirigir.' },
          { id: 'HIPAA.Security-ELBv2ACMCertificateRequired', reason: 'Sin `certificateArn` (solo dev sin PHI). En producción el contexto es obligatorio.' },
          { id: 'HIPAA.Security-ELBTlsHttpsListenersOnly', reason: 'Sin `certificateArn` (solo dev sin PHI).' },
        ],
        true,
      );
    }
    NagSuppressions.addResourceSuppressions(
      this.distribution,
      [
        { id: 'AwsSolutions-CFR1', reason: 'Geo-restricción opcional por contexto `geoAllowCountries` (decisión de la clínica: personal en viaje).' },
        ...(cfg.domainName
          ? []
          : [
              { id: 'AwsSolutions-CFR4', reason: 'Con el certificado por defecto de CloudFront (sin dominio propio) no se puede fijar la política TLS del viewer; con `domainName` + certificado se aplica TLSv1.2_2021.' },
              { id: 'HIPAA.Security-CloudFrontDistributionHttpsViewerNoOutdatedSSL', reason: 'Idem: aplica en cuanto se configura dominio propio y certificado ACM.' },
            ]),
        ...(cfg.certificateArn
          ? []
          : [
              { id: 'AwsSolutions-CFR5', reason: 'Sin `certificateArn` (solo dev sin PHI) el origen es HTTP.' },
              { id: 'HIPAA.Security-CloudFrontDistributionNoOutdatedSSL', reason: 'Sin `certificateArn` (solo dev sin PHI) el origen es HTTP.' },
            ]),
      ],
      true,
    );
  }
}
