import * as cdk from 'aws-cdk-lib';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { DeployConfig, resourceName, taskRoleName } from './config.js';

export interface FoundationStackProps extends cdk.StackProps {
  readonly config: DeployConfig;
}

export interface HelixonaTables {
  readonly conversations: dynamodb.Table;
  readonly messages: dynamodb.Table;
  readonly sessions: dynamodb.Table;
  readonly audit: dynamodb.Table;
  readonly usage: dynamodb.Table;
  readonly projects: dynamodb.Table;
  readonly training: dynamodb.Table;
}

/**
 * Cimientos con estado: CMK `phi-data`, tablas DynamoDB (§7 del contrato), buckets S3,
 * secretos de la aplicación, repositorio ECR y plan de AWS Backup.
 * Todo con `RemovalPolicy.RETAIN`: destruir el stack nunca destruye PHI.
 */
export class FoundationStack extends cdk.Stack {
  readonly phiKey: kms.Key;
  readonly tables: HelixonaTables;
  readonly attachmentsBucket: s3.Bucket;
  readonly logsBucket: s3.Bucket;
  readonly sessionSecret: secretsmanager.Secret;
  readonly cognitoClientSecret: secretsmanager.Secret;
  readonly anthropicApiKeySecret: secretsmanager.Secret;
  readonly apiRepository: ecr.Repository;

  constructor(scope: Construct, id: string, props: FoundationStackProps) {
    super(scope, id, props);
    const { stage } = props.config;
    const taskRoleArn = this.formatArn({
      service: 'iam',
      region: '',
      resource: 'role',
      resourceName: taskRoleName(stage),
    });

    // ---------------------------------------------------------------- KMS
    this.phiKey = new kms.Key(this, 'PhiDataKey', {
      alias: `alias/${resourceName(stage, 'phi-data')}`,
      description: `CMK para PHI en reposo (DynamoDB, S3, Secrets, Logs) - ${stage}`,
      enableKeyRotation: true,
      rotationPeriod: cdk.Duration.days(365),
      pendingWindow: cdk.Duration.days(30),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    // Nadie salvo el rol de la tarea descifra PHI directamente. Las llamadas que hacen los propios
    // servicios (DynamoDB/S3/Secrets Manager/Logs/Backup, `kms:ViaService` o principal de servicio)
    // quedan fuera del Deny para no romper la integración; el acceso a esos servicios ya lo
    // gobierna IAM y este Deny cubre el descifrado directo (p. ej. un humano con `kms:Decrypt`).
    this.phiKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyDirectDecryptExceptTaskRole',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['kms:Decrypt'],
        resources: ['*'],
        conditions: {
          StringNotEquals: { 'aws:PrincipalArn': taskRoleArn },
          Bool: { 'aws:PrincipalIsAWSService': 'false' },
          Null: { 'kms:ViaService': 'true' },
        },
      }),
    );

    // CloudWatch Logs cifra los log groups de la app y de WAF con esta CMK (contexto de cifrado del
    // propio log group de la cuenta/región).
    this.phiKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchLogsUseOfKey',
        principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
        actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
        resources: ['*'],
        conditions: {
          ArnLike: { 'kms:EncryptionContext:aws:logs:arn': `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:*` },
        },
      }),
    );

    // ----------------------------------------------------------- DynamoDB
    const tableDefaults: Partial<dynamodb.TableProps> = {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.phiKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    };
    const s = dynamodb.AttributeType.STRING;

    const conversations = new dynamodb.Table(this, 'ConversationsTable', {
      ...tableDefaults,
      tableName: resourceName(stage, 'conversations'),
      partitionKey: { name: 'userId', type: s },
      sortKey: { name: 'conversationId', type: s },
      timeToLiveAttribute: 'expiresAt',
    });
    const messages = new dynamodb.Table(this, 'MessagesTable', {
      ...tableDefaults,
      tableName: resourceName(stage, 'messages'),
      partitionKey: { name: 'conversationId', type: s },
      sortKey: { name: 'seq', type: s },
      timeToLiveAttribute: 'expiresAt',
    });
    const sessions = new dynamodb.Table(this, 'SessionsTable', {
      ...tableDefaults,
      tableName: resourceName(stage, 'sessions'),
      partitionKey: { name: 'sessionId', type: s },
      timeToLiveAttribute: 'expiresAt',
    });
    sessions.addGlobalSecondaryIndex({
      indexName: 'byUser',
      partitionKey: { name: 'userId', type: s },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    // Audit: sin TTL (retención larga; export a S3 con Object Lock en fase posterior).
    const audit = new dynamodb.Table(this, 'AuditTable', {
      ...tableDefaults,
      tableName: resourceName(stage, 'audit'),
      partitionKey: { name: 'day', type: s },
      sortKey: { name: 'sk', type: s },
    });
    audit.addGlobalSecondaryIndex({
      indexName: 'byUser',
      partitionKey: { name: 'userId', type: s },
      sortKey: { name: 'sk', type: s },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    const usage = new dynamodb.Table(this, 'UsageTable', {
      ...tableDefaults,
      tableName: resourceName(stage, 'usage'),
      partitionKey: { name: 'userId', type: s },
      sortKey: { name: 'day', type: s },
      timeToLiveAttribute: 'expiresAt',
    });
    // Projects: shared instructions and knowledge-file metadata (small table, no TTL).
    const projects = new dynamodb.Table(this, 'ProjectsTable', {
      ...tableDefaults,
      tableName: resourceName(stage, 'projects'),
      partitionKey: { name: 'projectId', type: s },
    });
    // Training: one row per user with the knowledge-check result and the acknowledgment (the
    // training log the Privacy Officer keeps for six years; no TTL).
    const training = new dynamodb.Table(this, 'TrainingTable', {
      ...tableDefaults,
      tableName: resourceName(stage, 'training'),
      partitionKey: { name: 'userId', type: s },
    });
    this.tables = { conversations, messages, sessions, audit, usage, projects, training };

    // --------------------------------------------------------- AWS Backup
    // Copia diaria (35 días) de las tablas a un vault cifrado con la CMK. Idealmente el vault
    // vive en una cuenta aislada con Vault Lock (fase posterior).
    const vault = new backup.BackupVault(this, 'BackupVault', {
      backupVaultName: resourceName(stage, 'vault'),
      encryptionKey: this.phiKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const plan = backup.BackupPlan.daily35DayRetention(this, 'BackupPlan', vault);
    plan.addSelection('Tables', {
      resources: Object.values(this.tables).map((t) => backup.BackupResource.fromDynamoDbTable(t)),
    });

    // ----------------------------------------------------------------- S3
    // Bucket de logs (ALB access logs, CloudFront standard logs, S3 access logs).
    // ALB y CloudFront solo entregan logs a buckets con SSE-S3 (no SSE-KMS): es la razón de la
    // excepción a la regla "todo con la CMK". Los logs de borde se tratan como potencialmente PHI:
    // retención corta y sin acceso público.
    this.logsBucket = new s3.Bucket(this, 'LogsBucket', {
      bucketName: resourceName(stage, `logs-${this.account}`),
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      // CloudFront (standard logging) escribe con ACL: requiere ACLs habilitadas.
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      lifecycleRules: [
        { id: 'expire-logs', expiration: cdk.Duration.days(90), noncurrentVersionExpiration: cdk.Duration.days(7) },
        { id: 'abort-mpu', abortIncompleteMultipartUploadAfter: cdk.Duration.days(7) },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Adjuntos (fase 2): claves UUID, SSE-KMS con la CMK, versionado, sin acceso público.
    this.attachmentsBucket = new s3.Bucket(this, 'AttachmentsBucket', {
      bucketName: resourceName(stage, `attachments-${this.account}`),
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.phiKey,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      serverAccessLogsBucket: this.logsBucket,
      serverAccessLogsPrefix: 's3-access/attachments/',
      lifecycleRules: [
        { id: 'noncurrent-35d', noncurrentVersionExpiration: cdk.Duration.days(35) },
        { id: 'abort-mpu', abortIncompleteMultipartUploadAfter: cdk.Duration.days(1) },
        // Conversation attachments follow the conversation retention (same TTL as the DynamoDB items).
        { id: 'expire-attachments', prefix: 'conversations/', expiration: cdk.Duration.days(props.config.retentionDays) },
      ],
      // The browser uploads directly with a presigned PUT, so the app origin needs CORS on the bucket.
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: [props.config.appBaseUrl],
          allowedHeaders: ['content-type'],
          exposedHeaders: ['ETag'],
          maxAge: 3600,
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // -------------------------------------------------------- Secrets Manager
    this.sessionSecret = new secretsmanager.Secret(this, 'SessionSecret', {
      secretName: resourceName(stage, 'session-secret'),
      description: 'Clave HMAC para firmar el id de sesión (SESSION_SECRET)',
      encryptionKey: this.phiKey,
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    // Placeholder: se rellena tras desplegar AuthStack (ver README). El valor real lo genera Cognito.
    this.cognitoClientSecret = new secretsmanager.Secret(this, 'CognitoClientSecret', {
      secretName: resourceName(stage, 'cognito-client-secret'),
      description: 'Client secret del app client de Cognito (COGNITO_CLIENT_SECRET). Rellenar tras AuthStack.',
      encryptionKey: this.phiKey,
      secretStringValue: cdk.SecretValue.unsafePlainText('REPLACE_ME_AFTER_AUTH_STACK'),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Clave de la Claude API de Anthropic (LLM_MODE=anthropic). Placeholder: se rellena a mano en
    // Secrets Manager con la clave generada en console.anthropic.com; nunca pasa por el repositorio ni por CI.
    this.anthropicApiKeySecret = new secretsmanager.Secret(this, 'AnthropicApiKeySecret', {
      secretName: resourceName(stage, 'anthropic-api-key'),
      description: 'Clave de la Claude API de Anthropic (ANTHROPIC_API_KEY). Rellenar a mano tras el despliegue.',
      encryptionKey: this.phiKey,
      secretStringValue: cdk.SecretValue.unsafePlainText('REPLACE_ME_WITH_ANTHROPIC_API_KEY'),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ---------------------------------------------------------------- ECR
    // El repositorio vive aquí (y no en AppStack) para poder hacer build+push de la imagen antes
    // del primer despliegue del servicio Fargate. `cdk synth` no necesita Docker.
    this.apiRepository = new ecr.Repository(this, 'ApiRepository', {
      repositoryName: resourceName(stage, 'api'),
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.MUTABLE,
      encryption: ecr.RepositoryEncryption.KMS,
      encryptionKey: this.phiKey,
      lifecycleRules: [{ description: 'Conservar las 20 imágenes más recientes', maxImageCount: 20 }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ------------------------------------------------------------- Outputs
    new cdk.CfnOutput(this, 'PhiKeyArn', { value: this.phiKey.keyArn, exportName: resourceName(stage, 'phi-key-arn') });
    for (const [name, table] of Object.entries(this.tables)) {
      new cdk.CfnOutput(this, `Table${name[0]!.toUpperCase()}${name.slice(1)}Name`, {
        value: table.tableName,
        exportName: resourceName(stage, `table-${name}`),
      });
    }
    new cdk.CfnOutput(this, 'AttachmentsBucketName', { value: this.attachmentsBucket.bucketName });
    new cdk.CfnOutput(this, 'LogsBucketName', { value: this.logsBucket.bucketName });
    new cdk.CfnOutput(this, 'SessionSecretArn', { value: this.sessionSecret.secretArn });
    new cdk.CfnOutput(this, 'CognitoClientSecretArn', { value: this.cognitoClientSecret.secretArn });
    new cdk.CfnOutput(this, 'AnthropicApiKeySecretArn', { value: this.anthropicApiKeySecret.secretArn });
    new cdk.CfnOutput(this, 'ApiRepositoryUri', { value: this.apiRepository.repositoryUri });

    // ---------------------------------------------------------- cdk-nag
    NagSuppressions.addResourceSuppressions(this.logsBucket, [
      { id: 'AwsSolutions-S1', reason: 'Es el bucket de logs de acceso; registrar su propio acceso sería recursivo.' },
      { id: 'HIPAA.Security-S3BucketLoggingEnabled', reason: 'Bucket destino de los access logs (recursivo).' },
      { id: 'HIPAA.Security-S3DefaultEncryptionKMS', reason: 'ALB y CloudFront solo entregan logs a buckets con SSE-S3; no soportan SSE-KMS.' },
      { id: 'HIPAA.Security-S3BucketReplicationEnabled', reason: 'Política de región única (residencia en EE.UU.); replicación fuera de alcance.' },
    ]);
    NagSuppressions.addResourceSuppressions(this.attachmentsBucket, [
      { id: 'HIPAA.Security-S3BucketReplicationEnabled', reason: 'Política de región única; la resiliencia se cubre con versionado y AWS Backup.' },
    ]);
    for (const table of Object.values(this.tables)) {
      NagSuppressions.addResourceSuppressions(table, [
        { id: 'HIPAA.Security-DynamoDBAutoScalingEnabled', reason: 'Tabla on-demand (PAY_PER_REQUEST); el autoscaling de capacidad no aplica.' },
      ]);
    }
    for (const secret of [this.sessionSecret, this.cognitoClientSecret, this.anthropicApiKeySecret]) {
      NagSuppressions.addResourceSuppressions(secret, [
        { id: 'AwsSolutions-SMG4', reason: 'Rotación manual documentada: rotar SESSION_SECRET invalida todas las sesiones, el client secret lo emite Cognito y la clave de Anthropic se rota desde console.anthropic.com; no hay lambda de rotación.' },
        { id: 'HIPAA.Security-SecretsManagerRotationEnabled', reason: 'Rotación manual documentada (ver README); rotación automática no aplicable a estos valores.' },
      ]);
    }
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `/${this.stackName}/BackupPlan/Tables/Role`,
      [{ id: 'AwsSolutions-IAM4', reason: 'AWSBackupServiceRolePolicyForBackup es la política gestionada oficial que exige AWS Backup.', appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup'] }],
      true,
    );
  }
}
