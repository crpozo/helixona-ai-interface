# @helixona/infra

Infraestructura AWS (CDK v2, TypeScript) de la interfaz Claude/Bedrock de la clínica. Cinco stacks:

| Stack | Contenido |
|---|---|
| `Helixona-<stage>-Foundation` | CMK `phi-data`, 5 tablas DynamoDB (§7 del contrato), buckets S3 (adjuntos, logs), secretos, repositorio ECR, AWS Backup |
| `Helixona-<stage>-Auth` | Cognito User Pool (sin autoregistro, MFA TOTP, grupos `staff`/`admin`), app client confidencial, dominio, WAF regional |
| `Helixona-<stage>-Network` | VPC 2 AZ, subredes públicas (solo ALB) y aisladas (Fargate), VPC endpoints, security groups |
| `Helixona-<stage>-App` | ECS Fargate, ALB (cabecera `X-Origin-Verify`), CloudFront + WAF global, rol de tarea de mínimo privilegio |
| `Helixona-<stage>-Observability` | Alarmas → SNS, AWS Budgets, CloudTrail y AWS Config opcionales |

`lib/scp-recommendations.json` contiene las SCPs recomendadas (regiones fuera de EE.UU., invocation logging de Bedrock, CloudTrail, perfiles `global.`); se aplican desde AWS Organizations, no desde este paquete.

## Prerrequisitos (antes de cualquier PHI)

1. **BAA de AWS aceptado en AWS Artifact** en la cuenta de producción (titular: la clínica). Sin BAA no se despliega en producción.
2. **Acceso a modelos habilitado** en Bedrock (us-east-1) para `anthropic.claude-sonnet-5`, `anthropic.claude-opus-5`, `anthropic.claude-opus-4-8` y `anthropic.claude-fable-5-1`.
3. **Certificado ACM** en `us-east-1` para el dominio (sirve para CloudFront y para el ALB, ya que todo se despliega en `us-east-1`). Sin `certificateArn` el ALB escucha en HTTP 80: solo para entornos de desarrollo sin PHI.
4. **Dominio** (`domainName`, `appBaseUrl`) y registro DNS apuntando a la distribución de CloudFront tras el despliegue.
5. Cuenta bootstrapeada (`cdk bootstrap aws://<cuenta>/us-east-1`) y rol OIDC para GitHub Actions (`AWS_DEPLOY_ROLE_ARN`).
6. SCPs de `lib/scp-recommendations.json` aplicadas a la OU de producción.

## Contexto de despliegue

Se pasa con `-c clave=valor` (o en `cdk.json`). Principales: `stage` (default `prod`), `appBaseUrl`, `domainName`, `certificateArn`, `cognitoDomainPrefix`, `alertEmail`, `monthlyBudgetUsd` (1500), `imageTag` (`latest`), `desiredCount` (1), `enableNat` (false), `tlsToContainer` (false), `enableCloudTrail` (false), `enableConfig` (false), `geoAllowCountries` (vacío), `cloudFrontPrefixListId`, `availabilityZones`.

## Comandos

```bash
# Desde la raíz del monorepo
CDK_DEFAULT_ACCOUNT=123456789012 CDK_DEFAULT_REGION=us-east-1 npm run synth -w @helixona/infra
npm run typecheck -w @helixona/infra
npm run test -w @helixona/infra      # assertions de CDK + cdk-nag sin errores
npm run diff -w @helixona/infra
```

`cdk synth` no necesita credenciales ni Docker: las AZs se resuelven con `Fn::GetAZs` y la imagen se toma del repositorio ECR (`imageTag`).

## Orden de despliegue

1. `cdk deploy Helixona-<stage>-Foundation` (crea el ECR `helixona-<stage>-api`).
2. Construir y publicar la imagen: `docker build -f packages/api/Dockerfile -t <cuenta>.dkr.ecr.us-east-1.amazonaws.com/helixona-<stage>-api:<tag> .` y `docker push`.
3. `cdk deploy --all -c imageTag=<tag> ...` (Auth → Network → App → Observability; CDK ordena por dependencias).
4. Rellenar `COGNITO_CLIENT_SECRET` (abajo) y forzar un nuevo despliegue del servicio.
5. Confirmar la suscripción de email de SNS, crear el registro DNS y el primer usuario `admin`.

El workflow `.github/workflows/deploy.yml` hace los pasos 1-3 con OIDC y aprobación del environment `production`.

## Rellenar `COGNITO_CLIENT_SECRET` tras el AuthStack

FoundationStack crea el secreto `helixona-<stage>-cognito-client-secret` con un placeholder; el valor real lo genera Cognito al crear el app client:

```bash
STAGE=prod
POOL_ID=$(aws cloudformation describe-stacks --stack-name Helixona-$STAGE-Auth --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)
CLIENT_ID=$(aws cloudformation describe-stacks --stack-name Helixona-$STAGE-Auth --query "Stacks[0].Outputs[?OutputKey=='UserPoolClientId'].OutputValue" --output text)
SECRET=$(aws cognito-idp describe-user-pool-client --user-pool-id "$POOL_ID" --client-id "$CLIENT_ID" --query UserPoolClient.ClientSecret --output text)
aws secretsmanager put-secret-value --secret-id helixona-$STAGE-cognito-client-secret --secret-string "$SECRET"
aws ecs update-service --cluster helixona-$STAGE-cluster --service helixona-$STAGE-api --force-new-deployment
```

Los secretos de ECS se leen al arrancar la tarea: cualquier cambio de secreto exige `--force-new-deployment`. Rotación de `SESSION_SECRET`: igual (invalida todas las sesiones). Rotación de `X-Origin-Verify`: cambiar el secreto `helixona-<stage>-origin-verify` y redesplegar `Helixona-<stage>-App`.

## Primer usuario

```bash
aws cognito-idp admin-create-user --user-pool-id "$POOL_ID" --username admin@clinica.example \
  --user-attributes Name=email,Value=admin@clinica.example Name=email_verified,Value=true Name=name,Value="Admin" \
  --desired-delivery-mediums EMAIL
aws cognito-idp admin-add-user-to-group --user-pool-id "$POOL_ID" --username admin@clinica.example --group-name admin
```

## Verificaciones pendientes (decisiones de riesgo, no bloquean el synth)

- **Retención de Fable 5.1 en Bedrock**: confirmar por escrito (BAA / documentación del modelo) que no hay retención ni entrenamiento con los prompts; registrarlo en el análisis de riesgos.
- **PrivateLink para Mantle** (`bedrock-mantle.<region>.api.aws`): el VPC endpoint desplegado es `bedrock-runtime`. Si Mantle no tiene PrivateLink, desplegar con `enableNat=true` (NAT Gateway + egreso 443) y acotar el egreso cuando se conozcan los rangos.
- **Acciones IAM de Mantle**: el rol de tarea permite `bedrock:InvokeModel*` sobre los foundation-models del catálogo y `inference-profile/us.anthropic.*`. Verificar si Mantle exige ARNs o acciones adicionales.
- **Core Rule Set en `/api/conversations*`**: implementado como exclusión por scope-down (no `count`) para no registrar fragmentos de texto clínico en los logs de WAF. Revisar con la clínica.
- **AWS Config / conformance pack HIPAA**: `enableConfig=true` y `hipaaConformancePackS3Uri` cuando exista un recorder en la cuenta.
- **CloudTrail**: `enableCloudTrail=true` solo si no hay trail de organización; añadir Object Lock al bucket.
- **Prefix list de CloudFront** (`cloudFrontPrefixListId`): el default `pl-3b927c52` es el de `us-east-1`; verificar en la cuenta (`aws ec2 describe-managed-prefix-lists --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing`).

## Acceso para desplegar sin compartir credenciales

1. Un administrador de la cuenta ejecuta una sola vez, con sus propias credenciales:
   ```bash
   npx cdk bootstrap aws://<ACCOUNT_ID>/us-east-1
   aws cloudformation deploy --stack-name helixona-github-deploy-role \
     --template-file packages/infra/bootstrap/github-oidc-deploy-role.yaml \
     --capabilities CAPABILITY_NAMED_IAM --region us-east-1
   aws cloudformation describe-stacks --stack-name helixona-github-deploy-role \
     --query "Stacks[0].Outputs[?OutputKey=='DeployRoleArn'].OutputValue" --output text
   ```
2. En GitHub → Settings → Environments → `production`: añadir revisores obligatorios.
3. En GitHub → Settings → Secrets → `AWS_DEPLOY_ROLE_ARN` = el ARN que devolvió el paso 1.
4. Ejecutar el workflow **Deploy** (`workflow_dispatch`). El rol solo puede asumir los roles del bootstrap de CDK y publicar imágenes en los repositorios ECR `helixona-*`; no hay claves estáticas en ningún sitio.
