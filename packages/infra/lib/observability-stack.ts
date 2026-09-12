import * as cdk from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as config from 'aws-cdk-lib/aws-config';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { DeployConfig, resourceName } from './config.js';

export interface ObservabilityStackProps extends cdk.StackProps {
  readonly config: DeployConfig;
  readonly loadBalancer: elbv2.IApplicationLoadBalancer;
  readonly targetGroup: elbv2.IApplicationTargetGroup;
  readonly service: ecs.FargateService;
  readonly appLogGroup: logs.ILogGroup;
  readonly logsBucket: s3.IBucket;
  readonly tables: dynamodb.ITable[];
  readonly attachmentsBucket: s3.IBucket;
}

/**
 * Alarmas (sin PHI), presupuesto, y opcionalmente CloudTrail propio y AWS Config.
 */
export class ObservabilityStack extends cdk.Stack {
  readonly alertsTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);
    const cfg = props.config;
    const { stage } = cfg;

    // ------------------------------------------------------------ SNS + KMS
    // Clave propia para alertas (no la CMK de PHI): CloudWatch y Budgets necesitan usarla.
    const alertsKey = new kms.Key(this, 'AlertsKey', {
      alias: `alias/${resourceName(stage, 'alerts')}`,
      description: `CMK para el topic SNS de alertas - ${stage}`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    for (const svc of ['cloudwatch.amazonaws.com', 'budgets.amazonaws.com']) {
      alertsKey.addToResourcePolicy(
        new iam.PolicyStatement({
          principals: [new iam.ServicePrincipal(svc)],
          actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
          resources: ['*'],
          conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
        }),
      );
    }
    this.alertsTopic = new sns.Topic(this, 'AlertsTopic', {
      topicName: resourceName(stage, 'alerts'),
      displayName: `Helixona ${stage} alerts`,
      masterKey: alertsKey,
      enforceSSL: true,
    });
    this.alertsTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowBudgetsPublish',
        principals: [new iam.ServicePrincipal('budgets.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [this.alertsTopic.topicArn],
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    );
    if (cfg.alertEmail) {
      this.alertsTopic.addSubscription(new subscriptions.EmailSubscription(cfg.alertEmail));
    } else {
      cdk.Annotations.of(this).addWarningV2('helixona:no-alert-email', 'Sin `alertEmail` en contexto: el topic de alertas no tiene suscriptores.');
    }
    const alarmAction = new cwActions.SnsAction(this.alertsTopic);

    // ------------------------------------------------------------- Alarmas
    const alarm = (idSuffix: string, props: cloudwatch.AlarmProps): cloudwatch.Alarm => {
      const a = new cloudwatch.Alarm(this, `${idSuffix}Alarm`, {
        alarmName: resourceName(stage, idSuffix.toLowerCase()),
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        ...props,
      });
      a.addAlarmAction(alarmAction);
      a.addOkAction(alarmAction);
      return a;
    };

    alarm('Alb5xx', {
      alarmDescription: 'Respuestas 5xx generadas por el ALB (sin target sano, timeouts) >= 5 en 5 min',
      metric: props.loadBalancer.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, { period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });
    alarm('Target5xx', {
      alarmDescription: 'Respuestas 5xx de la API >= 10 en 5 min',
      metric: props.targetGroup.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 10,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });
    alarm('UnhealthyTargets', {
      alarmDescription: 'Algún target del ALB no está sano',
      metric: props.targetGroup.metrics.unhealthyHostCount({ period: cdk.Duration.minutes(1), statistic: 'Maximum' }),
      threshold: 1,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });
    alarm('NoHealthyTargets', {
      alarmDescription: 'Ningún target sano: servicio caído',
      metric: props.targetGroup.metrics.healthyHostCount({ period: cdk.Duration.minutes(1), statistic: 'Minimum' }),
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    alarm('HighCpu', {
      alarmDescription: 'CPU media del servicio > 80% durante 10 min',
      metric: props.service.metricCpuUtilization({ period: cdk.Duration.minutes(5), statistic: 'Average' }),
      threshold: 80,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });
    alarm('HighMemory', {
      alarmDescription: 'Memoria media del servicio > 85% durante 10 min',
      metric: props.service.metricMemoryUtilization({ period: cdk.Duration.minutes(5), statistic: 'Average' }),
      threshold: 85,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });
    // Errores de la tarea: líneas de log con nivel error (pino: level >= 50). Solo se cuenta; el
    // filtro no extrae ningún campo (los logs no contienen PHI por diseño, pero no se copia nada).
    const errorMetric = new logs.MetricFilter(this, 'AppErrorsFilter', {
      logGroup: props.appLogGroup,
      filterPattern: logs.FilterPattern.numberValue('$.level', '>=', 50),
      metricNamespace: `Helixona/${stage}`,
      metricName: 'AppErrors',
      metricValue: '1',
      defaultValue: 0,
      unit: cloudwatch.Unit.COUNT,
    });
    alarm('AppErrors', {
      alarmDescription: 'Errores de aplicación (nivel error) >= 5 en 5 min',
      metric: errorMetric.metric({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });

    // ------------------------------------------------------------- Budgets
    const subscribers: budgets.CfnBudget.SubscriberProperty[] = [{ subscriptionType: 'SNS', address: this.alertsTopic.topicArn }];
    if (cfg.alertEmail) subscribers.push({ subscriptionType: 'EMAIL', address: cfg.alertEmail });
    const notification = (threshold: number, type: 'ACTUAL' | 'FORECASTED'): budgets.CfnBudget.NotificationWithSubscribersProperty => ({
      notification: { notificationType: type, comparisonOperator: 'GREATER_THAN', threshold, thresholdType: 'PERCENTAGE' },
      subscribers,
    });
    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: resourceName(stage, 'monthly'),
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: cfg.monthlyBudgetUsd, unit: 'USD' },
      },
      notificationsWithSubscribers: [notification(50, 'ACTUAL'), notification(80, 'ACTUAL'), notification(100, 'ACTUAL'), notification(100, 'FORECASTED')],
    });

    // ---------------------------------------------------------- CloudTrail
    // Normalmente ya existe un trail de organización; este es opcional (`enableCloudTrail`).
    if (cfg.enableCloudTrail) {
      const trailKey = new kms.Key(this, 'TrailKey', {
        alias: `alias/${resourceName(stage, 'cloudtrail')}`,
        enableKeyRotation: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
      const trailBucket = new s3.Bucket(this, 'TrailBucket', {
        bucketName: resourceName(stage, `cloudtrail-${this.account}`),
        encryption: s3.BucketEncryption.KMS,
        encryptionKey: trailKey,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        versioned: true,
        // TODO: Object Lock (COMPLIANCE) para inmutabilidad; requiere decidir el periodo con la clínica.
        serverAccessLogsBucket: props.logsBucket,
        serverAccessLogsPrefix: 's3-access/cloudtrail/',
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
      // Log group propio (el que crea `Trail` por defecto no va cifrado con KMS).
      trailKey.addToResourcePolicy(
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
      const trailLogGroup = new logs.LogGroup(this, 'TrailLogGroup', {
        logGroupName: `/helixona/${stage}/cloudtrail`,
        retention: logs.RetentionDays.ONE_YEAR,
        encryptionKey: trailKey,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
      const trail = new cloudtrail.Trail(this, 'Trail', {
        trailName: resourceName(stage, 'trail'),
        bucket: trailBucket,
        encryptionKey: trailKey,
        enableFileValidation: true,
        includeGlobalServiceEvents: true,
        isMultiRegionTrail: true,
        sendToCloudWatchLogs: true,
        cloudWatchLogGroup: trailLogGroup,
      });
      // Data events: quién toca las tablas con PHI y el bucket de adjuntos.
      trail.addS3EventSelector([{ bucket: props.attachmentsBucket }], { readWriteType: cloudtrail.ReadWriteType.ALL });
      // El enum de CDK no incluye DynamoDB, pero CloudTrail acepta `AWS::DynamoDB::Table` como DataResource.
      trail.addEventSelector('AWS::DynamoDB::Table' as cloudtrail.DataResourceType, props.tables.map((t) => t.tableArn), {
        readWriteType: cloudtrail.ReadWriteType.ALL,
      });
      NagSuppressions.addResourceSuppressions(trailBucket, [
        { id: 'HIPAA.Security-S3BucketReplicationEnabled', reason: 'Política de región única; el trail es multi-región pero el bucket vive en la región principal.' },
      ]);
      NagSuppressions.addResourceSuppressions(
        trail,
        [{ id: 'HIPAA.Security-IAMNoInlinePolicy', reason: 'Política inline generada por CDK para el rol que entrega CloudTrail a CloudWatch Logs.' }],
        true,
      );
    }

    // ---------------------------------------------------------- AWS Config
    // Deshabilitado por defecto: requiere un Configuration Recorder activo en la cuenta (normalmente
    // lo despliega la organización). Cuando se habilite, el conformance pack
    // "Operational Best Practices for HIPAA Security" (aws-config-rules/aws-config-conformance-packs)
    // se despliega desde `hipaaConformancePackS3Uri` y se añaden reglas gestionadas clave.
    if (cfg.enableConfig) {
      new config.ManagedRule(this, 'DynamoDbKmsRule', {
        identifier: config.ManagedRuleIdentifiers.DYNAMODB_TABLE_ENCRYPTED_KMS,
        configRuleName: resourceName(stage, 'ddb-kms'),
      });
      new config.ManagedRule(this, 'S3SseRule', {
        identifier: config.ManagedRuleIdentifiers.S3_BUCKET_SERVER_SIDE_ENCRYPTION_ENABLED,
        configRuleName: resourceName(stage, 's3-sse'),
      });
      new config.ManagedRule(this, 'CloudTrailEnabledRule', {
        identifier: config.ManagedRuleIdentifiers.CLOUD_TRAIL_ENABLED,
        configRuleName: resourceName(stage, 'cloudtrail-enabled'),
      });
      if (cfg.hipaaConformancePackS3Uri) {
        new config.CfnConformancePack(this, 'HipaaConformancePack', {
          conformancePackName: resourceName(stage, 'hipaa-security'),
          templateS3Uri: cfg.hipaaConformancePackS3Uri,
        });
      }
    }

    new cdk.CfnOutput(this, 'AlertsTopicArn', { value: this.alertsTopic.topicArn });
  }
}
