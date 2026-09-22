import * as cdk from 'aws-cdk-lib';

/**
 * Configuración de despliegue derivada del contexto de CDK (`cdk.json` → `context`,
 * o `-c clave=valor` en la CLI). Todos los valores tienen default seguro para `cdk synth`.
 */
export interface DeployConfig {
  /** Etapa: `prod`, `staging`, `dev`... Prefija todos los nombres de recursos. */
  readonly stage: string;
  /** URL pública de la app (sin barra final). Se usa para las redirecciones OIDC. */
  readonly appBaseUrl: string;
  /** Dominio propio para CloudFront (opcional). */
  readonly domainName?: string;
  /** ARN de certificado ACM para el ALB (región del stack). Si falta, se crea listener HTTP 80 (solo dev). */
  readonly certificateArn?: string;
  /** ARN de certificado ACM en us-east-1 para CloudFront. Si falta, se usa `certificateArn`. */
  readonly cloudFrontCertificateArn?: string;
  /** Prefijo del dominio de Cognito (`https://<prefijo>.auth.<region>.amazoncognito.com`). */
  readonly cognitoDomainPrefix: string;
  /** Proveedor de modelos: `anthropic` (Claude API, clave en Secrets Manager) o `bedrock`. */
  readonly llmMode: 'anthropic' | 'bedrock';
  /** Crear NAT Gateway (egreso a Internet). Forzado a true con `llmMode=anthropic` (api.anthropic.com). */
  readonly enableNat: boolean;
  /** TLS entre ALB y contenedor (el contenedor debe servir HTTPS con certificado autofirmado). */
  readonly tlsToContainer: boolean;
  /** Tag de la imagen en el repositorio ECR. */
  readonly imageTag: string;
  /** Nº de tareas Fargate deseadas (1-2). */
  readonly desiredCount: number;
  /** Email para las alertas (SNS). Vacío = sin suscripción. */
  readonly alertEmail?: string;
  /** Presupuesto mensual (USD) para AWS Budgets. */
  readonly monthlyBudgetUsd: number;
  /** Crear CloudTrail propio (normalmente ya existe a nivel de organización). */
  readonly enableCloudTrail: boolean;
  /** Crear reglas de AWS Config / conformance pack HIPAA (requiere recorder activo). */
  readonly enableConfig: boolean;
  /** URI S3 de la plantilla del conformance pack HIPAA (si `enableConfig`). */
  readonly hipaaConformancePackS3Uri?: string;
  /** Retención de conversaciones/mensajes (días) → `RETENTION_DAYS`. */
  readonly retentionDays: number;
  /** Países permitidos en CloudFront (ISO 3166-1 alpha-2). Vacío = sin geo-restricción. */
  readonly geoAllowCountries: string[];
  /** ID de la prefix list gestionada `com.amazonaws.global.cloudfront.origin-facing` de la región. */
  readonly cloudFrontPrefixListId?: string;
  /** AZs fijas para la VPC (>= 2). Vacío = las dos primeras de `Fn::GetAZs`. */
  readonly availabilityZones?: string[];
}

function str(scope: cdk.App, key: string, fallback = ''): string {
  const v = scope.node.tryGetContext(key);
  // Una cadena vacía (p. ej. `-c clave=` desde CI con una variable sin definir) cuenta como "no dado".
  return v === undefined || v === null || String(v).trim() === '' ? fallback : String(v);
}
function bool(scope: cdk.App, key: string, fallback: boolean): boolean {
  const v = scope.node.tryGetContext(key);
  if (v === undefined || v === null || v === '') return fallback;
  return v === true || v === 'true' || v === '1';
}
function num(scope: cdk.App, key: string, fallback: number): number {
  const v = scope.node.tryGetContext(key);
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Contexto "${key}" no es numérico: ${String(v)}`);
  return n;
}
function opt(v: string): string | undefined {
  return v.trim() === '' ? undefined : v.trim();
}

export function loadConfig(app: cdk.App): DeployConfig {
  const stage = str(app, 'stage', 'prod');
  if (!/^[a-z][a-z0-9-]{1,15}$/.test(stage)) {
    throw new Error(`Contexto "stage" inválido: "${stage}" (minúsculas, dígitos y guiones, 2-16 chars)`);
  }
  const appBaseUrl = str(app, 'appBaseUrl', 'https://chat.example-clinic.test').replace(/\/+$/, '');
  const llmModeRaw = str(app, 'llmMode', 'anthropic');
  if (llmModeRaw !== 'anthropic' && llmModeRaw !== 'bedrock') throw new Error(`Contexto "llmMode" inválido: "${llmModeRaw}" (anthropic | bedrock)`);
  const llmMode = llmModeRaw as 'anthropic' | 'bedrock';
  const desiredCount = num(app, 'desiredCount', 1);
  if (desiredCount < 1 || desiredCount > 2) throw new Error('Contexto "desiredCount" debe ser 1 o 2');
  const geo = str(app, 'geoAllowCountries', '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length === 2);
  const azs = str(app, 'availabilityZones', '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return {
    stage,
    appBaseUrl,
    domainName: opt(str(app, 'domainName')),
    certificateArn: opt(str(app, 'certificateArn')),
    cloudFrontCertificateArn: opt(str(app, 'cloudFrontCertificateArn')),
    cognitoDomainPrefix: str(app, 'cognitoDomainPrefix', `helixona-${stage}`),
    llmMode,
    // La Claude API vive en Internet: el contenedor necesita egreso (NAT). Con Bedrock puede ir por PrivateLink.
    enableNat: bool(app, 'enableNat', false) || llmMode === 'anthropic',
    tlsToContainer: bool(app, 'tlsToContainer', false),
    imageTag: str(app, 'imageTag', 'latest'),
    desiredCount,
    alertEmail: opt(str(app, 'alertEmail')),
    monthlyBudgetUsd: num(app, 'monthlyBudgetUsd', 1500),
    enableCloudTrail: bool(app, 'enableCloudTrail', false),
    enableConfig: bool(app, 'enableConfig', false),
    hipaaConformancePackS3Uri: opt(str(app, 'hipaaConformancePackS3Uri')),
    retentionDays: num(app, 'retentionDays', 30),
    geoAllowCountries: geo,
    cloudFrontPrefixListId: opt(str(app, 'cloudFrontPrefixListId')),
    availabilityZones: azs.length >= 2 ? azs : undefined,
  };
}

/** Nombre de recurso con prefijo de proyecto y etapa: `helixona-<stage>-<suffix>`. */
export function resourceName(stage: string, suffix: string): string {
  return `helixona-${stage}-${suffix}`;
}

/** Modelos del catálogo (§6 del contrato). Deben coincidir con `MODEL_CATALOG_JSON`. */
export const CATALOG_MODEL_IDS = [
  'anthropic.claude-sonnet-5',
  'anthropic.claude-opus-5-5',
  'anthropic.claude-opus-5',
  'anthropic.claude-fable-5-1',
] as const;

/** Nombre del rol de tarea ECS. Se fija aquí porque la política de la CMK (FoundationStack) lo referencia. */
export function taskRoleName(stage: string): string {
  return resourceName(stage, 'task-role');
}
