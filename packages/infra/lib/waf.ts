import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

/** Regla gestionada de AWS WAF (vendor AWS). */
export function managedRule(
  name: string,
  priority: number,
  managedName: string,
  opts: { count?: boolean; scopeDown?: wafv2.CfnWebACL.StatementProperty } = {},
): wafv2.CfnWebACL.RuleProperty {
  return {
    name,
    priority,
    overrideAction: opts.count ? { count: {} } : { none: {} },
    statement: {
      managedRuleGroupStatement: {
        vendorName: 'AWS',
        name: managedName,
        ...(opts.scopeDown ? { scopeDownStatement: opts.scopeDown } : {}),
      },
    },
    visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: name },
  };
}

/** Rate limit por IP (bloquea) en ventana de 5 minutos. */
export function rateLimitRule(name: string, priority: number, limit: number): wafv2.CfnWebACL.RuleProperty {
  return {
    name,
    priority,
    action: { block: {} },
    statement: { rateBasedStatement: { limit, aggregateKeyType: 'IP' } },
    visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: name },
  };
}

export interface WafLoggingProps {
  readonly webAcl: wafv2.CfnWebACL;
  readonly logGroupName: string; // debe empezar por `aws-waf-logs-`
  readonly encryptionKey: kms.IKey;
}

/**
 * Logging del WebACL a CloudWatch Logs con los campos `authorization` y `cookie` redactados
 * (los logs de borde son potencialmente PHI). Retención de 1 año, cifrado con la CMK.
 */
export function addWafLogging(scope: Construct, id: string, props: WafLoggingProps): logs.LogGroup {
  const stack = cdk.Stack.of(scope);
  const logGroup = new logs.LogGroup(scope, `${id}LogGroup`, {
    logGroupName: props.logGroupName,
    retention: logs.RetentionDays.ONE_YEAR,
    encryptionKey: props.encryptionKey,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });
  // WAF entrega a través de "logs delivery": necesita política de recurso en el log group.
  logGroup.addToResourcePolicy(
    new iam.PolicyStatement({
      sid: 'AllowWafLogDelivery',
      principals: [new iam.ServicePrincipal('delivery.logs.amazonaws.com')],
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`${logGroup.logGroupArn}`],
      conditions: {
        StringEquals: { 'aws:SourceAccount': stack.account },
        ArnLike: { 'aws:SourceArn': `arn:${stack.partition}:logs:${stack.region}:${stack.account}:*` },
      },
    }),
  );
  // La configuración de logging exige el ARN del log group SIN el sufijo `:*`.
  const logGroupArnNoWildcard = stack.formatArn({
    service: 'logs',
    resource: 'log-group',
    resourceName: props.logGroupName,
    arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
  });
  const cfg = new wafv2.CfnLoggingConfiguration(scope, `${id}Logging`, {
    resourceArn: props.webAcl.attrArn,
    logDestinationConfigs: [logGroupArnNoWildcard],
    redactedFields: [{ singleHeader: { Name: 'authorization' } }, { singleHeader: { Name: 'cookie' } }],
  });
  cfg.node.addDependency(logGroup);
  return logGroup;
}
