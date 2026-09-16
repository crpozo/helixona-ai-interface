import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { DeployConfig, resourceName } from './config.js';

export interface NetworkStackProps extends cdk.StackProps {
  readonly config: DeployConfig;
  readonly logsBucket: s3.IBucket;
}

/**
 * Red: VPC de 2 AZ con subredes públicas (solo ALB) y privadas aisladas (Fargate), sin NAT por
 * defecto. Todo el tráfico a servicios AWS sale por VPC endpoints. Security groups mínimos.
 */
export class NetworkStack extends cdk.Stack {
  readonly vpc: ec2.Vpc;
  readonly albSecurityGroup: ec2.SecurityGroup;
  /** Only with `certificateArn`: the HTTPS ingress from CloudFront lives here (see the constructor). */
  readonly albHttpsSecurityGroup?: ec2.SecurityGroup;
  readonly appSecurityGroup: ec2.SecurityGroup;
  readonly endpointsSecurityGroup: ec2.SecurityGroup;
  /** Subredes donde corren las tareas (aisladas, o con egreso si `enableNat`). */
  readonly appSubnets: ec2.SubnetSelection;

  private readonly pinnedAzs: string[] | undefined;

  /**
   * AZs sin lookup de contexto (que exigiría credenciales AWS en `cdk synth`/CI): por defecto las dos
   * primeras que devuelve `Fn::GetAZs`; se pueden fijar con el contexto `availabilityZones`.
   */
  override get availabilityZones(): string[] {
    if (this.pinnedAzs && this.pinnedAzs.length >= 2) return this.pinnedAzs;
    return [cdk.Fn.select(0, cdk.Fn.getAzs()), cdk.Fn.select(1, cdk.Fn.getAzs())];
  }

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    const { stage, enableNat, certificateArn, cloudFrontPrefixListId } = props.config;
    this.pinnedAzs = props.config.availabilityZones;

    const appSubnetType = enableNat ? ec2.SubnetType.PRIVATE_WITH_EGRESS : ec2.SubnetType.PRIVATE_ISOLATED;
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: resourceName(stage, 'vpc'),
      ipAddresses: ec2.IpAddresses.cidr('10.40.0.0/16'),
      maxAzs: 2,
      // TODO(Mantle): verificar si existe PrivateLink para `bedrock-mantle.<region>.api.aws`.
      // Mientras no exista, `enableNat=true` crea un NAT Gateway para el egreso al endpoint público
      // de Mantle (y el SG de la app deberá permitir 443 saliente a Internet). Con `enableNat=false`
      // la app solo alcanza `bedrock-runtime` por su VPC endpoint.
      natGateways: enableNat ? 1 : 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24, mapPublicIpOnLaunch: false },
        { name: 'app', subnetType: appSubnetType, cidrMask: 22 },
      ],
      restrictDefaultSecurityGroup: true,
    });
    this.appSubnets = { subnetType: appSubnetType };

    // Flow logs (evidencia; sin contenido). Van al bucket de logs, con retención corta.
    this.vpc.addFlowLog('FlowLog', {
      destination: ec2.FlowLogDestination.toS3(props.logsBucket, 'vpc-flow-logs/'),
      trafficType: ec2.FlowLogTrafficType.REJECT,
      maxAggregationInterval: ec2.FlowLogMaxAggregationInterval.TEN_MINUTES,
    });

    // ------------------------------------------------------ Security groups
    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: this.vpc,
      securityGroupName: resourceName(stage, 'alb'),
      description: 'ALB: solo desde CloudFront (prefix list gestionada) y solo hacia la app',
      allowAllOutbound: false,
    });
    // Origen permitido: la prefix list gestionada `com.amazonaws.global.cloudfront.origin-facing`
    // (su ID varía por región; `pl-3b927c52` es la de us-east-1). Defensa en profundidad: además el
    // listener exige la cabecera secreta X-Origin-Verify.
    const cfPrefixListId = cloudFrontPrefixListId ?? (this.region === 'us-east-1' ? 'pl-3b927c52' : undefined);
    const albIngressPeer = cfPrefixListId ? ec2.Peer.prefixList(cfPrefixListId) : ec2.Peer.anyIpv4();
    if (!cfPrefixListId) {
      cdk.Annotations.of(this).addWarningV2(
        'helixona:cloudfront-prefix-list',
        'Sin `cloudFrontPrefixListId` en contexto: el ALB acepta 443 desde cualquier IP (la cabecera X-Origin-Verify sigue protegiendo).',
      );
    }
    // The CloudFront prefix list counts as ~55 of the 60 rules a security group may hold, so the HTTP
    // and HTTPS ingress rules cannot share one group (CloudFormation creates new rules before it
    // deletes old ones, so even a port change fails with "maximum number of rules"). Without a
    // certificate the base group carries the HTTP rule; with one, a second group carries the HTTPS
    // rule and is attached to the ALB next to the base group, which keeps the egress rule to the app.
    if (certificateArn) {
      this.albHttpsSecurityGroup = new ec2.SecurityGroup(this, 'AlbHttpsSg', {
        vpc: this.vpc,
        securityGroupName: resourceName(stage, 'alb-https'),
        description: 'ALB: HTTPS solo desde CloudFront (prefix list gestionada)',
        allowAllOutbound: false,
      });
      this.albHttpsSecurityGroup.addIngressRule(albIngressPeer, ec2.Port.tcp(443), 'Desde CloudFront (443)');
    } else {
      this.albSecurityGroup.addIngressRule(albIngressPeer, ec2.Port.tcp(80), 'Desde CloudFront (80)');
    }

    this.appSecurityGroup = new ec2.SecurityGroup(this, 'AppSg', {
      vpc: this.vpc,
      securityGroupName: resourceName(stage, 'app'),
      description: 'Tareas Fargate de la API',
      allowAllOutbound: false,
    });
    this.appSecurityGroup.addIngressRule(this.albSecurityGroup, ec2.Port.tcp(3000), 'Desde el ALB al contenedor');
    this.albSecurityGroup.addEgressRule(this.appSecurityGroup, ec2.Port.tcp(3000), 'Hacia el contenedor');

    this.endpointsSecurityGroup = new ec2.SecurityGroup(this, 'EndpointsSg', {
      vpc: this.vpc,
      securityGroupName: resourceName(stage, 'vpce'),
      description: 'VPC endpoints de interfaz: 443 solo desde la app',
      allowAllOutbound: false,
    });
    this.endpointsSecurityGroup.addIngressRule(this.appSecurityGroup, ec2.Port.tcp(443), 'HTTPS desde la app');
    // Egreso de la app: solo 443. Los gateway endpoints (S3/DynamoDB) se alcanzan por rutas hacia
    // prefix lists del servicio (sin ID estable en CloudFormation), así que el egreso se expresa como
    // 443 a cualquier destino: en subredes aisladas la tabla de rutas solo llega a los VPC endpoints;
    // con `enableNat` además llega a Internet (endpoint público de Mantle; TODO acotar cuando exista
    // PrivateLink).
    this.appSecurityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS a VPC endpoints (y a Internet si enableNat)');

    // ------------------------------------------------------- VPC endpoints
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [{ subnetType: appSubnetType }],
    });
    this.vpc.addGatewayEndpoint('DynamoDbEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
      subnets: [{ subnetType: appSubnetType }],
    });

    const interfaceServices: Array<[string, ec2.InterfaceVpcEndpointAwsService]> = [
      ['Kms', ec2.InterfaceVpcEndpointAwsService.KMS],
      ['Logs', ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS],
      ['EcrApi', ec2.InterfaceVpcEndpointAwsService.ECR],
      ['EcrDkr', ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER],
      ['Sts', ec2.InterfaceVpcEndpointAwsService.STS],
      ['SecretsManager', ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER],
      ['Ssm', ec2.InterfaceVpcEndpointAwsService.SSM],
      // TODO(Mantle): `bedrock-runtime` cubre el endpoint estándar de Bedrock. Verificar si el
      // endpoint Mantle (`bedrock-mantle.<region>.api.aws`) dispone de PrivateLink; si no, `enableNat`.
      ['BedrockRuntime', ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME],
    ];
    for (const [name, service] of interfaceServices) {
      this.vpc.addInterfaceEndpoint(`${name}Endpoint`, {
        service,
        open: false, // sin regla de ingreso desde todo el CIDR: solo desde el SG de la app
        privateDnsEnabled: true,
        subnets: { subnetType: appSubnetType },
        securityGroups: [this.endpointsSecurityGroup],
      });
    }

    new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });

    // ---------------------------------------------------------- cdk-nag
    NagSuppressions.addResourceSuppressions(
      this.vpc,
      [
        {
          id: 'HIPAA.Security-VPCNoUnrestrictedRouteToIGW',
          reason: 'La ruta 0.0.0.0/0 al IGW existe solo en las subredes públicas, que alojan únicamente el ALB (internet-facing por diseño). Las tareas corren en subredes aisladas sin ruta a Internet.',
        },
      ],
      true,
    );
    if (!cfPrefixListId) {
      const reason = 'ALB público sin prefix list de CloudFront configurada; la cabecera secreta X-Origin-Verify bloquea el tráfico que no venga de CloudFront.';
      NagSuppressions.addResourceSuppressions(this.albSecurityGroup, [{ id: 'AwsSolutions-EC23', reason }]);
      if (this.albHttpsSecurityGroup) NagSuppressions.addResourceSuppressions(this.albHttpsSecurityGroup, [{ id: 'AwsSolutions-EC23', reason }]);
    }
  }
}
