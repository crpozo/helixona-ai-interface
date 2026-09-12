# Helixona AI Interface — asistente Claude privado para la clínica

Interfaz web propia para que el personal de una clínica sujeta a HIPAA use Claude (Sonnet 5, Opus 5 o Fable 5.1, siempre en su última versión) a través de **Amazon Bedrock**, con usuario y contraseña + MFA en **Amazon Cognito**, sesiones del lado servidor, historial cifrado con KMS y auditoría sin contenido.

- Diseño y decisiones: [`docs/DISENO-ARQUITECTURA.md`](docs/DISENO-ARQUITECTURA.md)
- Contrato técnico (rutas, eventos SSE, variables, tablas): [`docs/CONTRATO.md`](docs/CONTRATO.md)
- Infraestructura (CDK) y despliegue: [`packages/infra/README.md`](packages/infra/README.md)

## Paquetes

| Paquete | Qué es |
|---|---|
| `packages/core` | Catálogo de modelos configurable, `ModelRouter` (elección por conversación, fallback por rechazo vía middleware del SDK y por indisponibilidad vía router propio, pin por conversación, breaker), regla de historial append-only, logger de esquema cerrado (nunca PHI en logs), proveedor Bedrock (cliente Mantle) y proveedor falso para desarrollo |
| `packages/api` | Fastify: login Cognito (Authorization Code + PKCE) o modo dev, sesiones server-side con cookie opaca, CSRF por cabecera, cabeceras de seguridad/CSP, conversaciones, chat por SSE, administración, auditoría, cuotas; repositorios DynamoDB o en memoria; sirve la SPA compilada |
| `packages/web` | SPA React/Vite: selector de modelo, chat con streaming, Markdown sanitizado sin imágenes remotas, cierre por inactividad, panel de administración |
| `packages/infra` | AWS CDK: KMS, DynamoDB, S3, Cognito, VPC y endpoints, ECS Fargate, ALB, CloudFront + WAF, alarmas y presupuesto; cdk-nag con reglas HIPAA |

## Desarrollo local (sin AWS)

Requisitos: Node 22.

```bash
npm ci
npm run build -w @helixona/core
npm run dev:api          # API en :3000 con AUTH_MODE=dev, STORE_MODE=memory, LLM_MODE=fake
npm run dev:web          # Vite en :5173 con proxy /api → :3000 (muestra el acceso de desarrollo)
```

El proveedor falso responde sin Bedrock y entiende órdenes al inicio del mensaje para simular casos: `/refuse` (rechazo y continuación en el modelo de respaldo), `/refuse-mid`, `/refuse-all`, `/throttle`, `/throttle-mid`, `/hang`, `/long`.

Para probar la SPA compilada desde la API (mismo origen, como en producción):

```bash
npm run build
cd packages/api && AUTH_MODE=dev STORE_MODE=memory LLM_MODE=fake SESSION_SECRET=un-secreto-largo WEB_DIST=../web/dist node dist/server.js
```

Con la SPA compilada no hay formulario de acceso de desarrollo; inicia sesión con `POST /api/auth/dev-login` (ver `docs/CONTRATO.md`).

## Verificación

```bash
npm run typecheck
npm run test
npm run build
CDK_DEFAULT_ACCOUNT=123456789012 CDK_DEFAULT_REGION=us-east-1 npm run synth
```

## Producción (resumen)

1. Cuenta AWS a nombre de la clínica; **BAA aceptado en AWS Artifact antes de cualquier PHI**; BAA Helixona–clínica.
2. Habilitar en Bedrock los modelos del catálogo y confirmar por escrito las verificaciones abiertas (sección 12 del diseño: retención de Fable 5.1 en Bedrock, cobertura del endpoint Mantle, PrivateLink, acciones IAM).
3. `cdk deploy` (ver `packages/infra/README.md`), rellenar `COGNITO_CLIENT_SECRET` en Secrets Manager, crear usuarios desde el panel de administración (alta solo por administrador, MFA obligatoria).
4. Catálogo de modelos y parámetros operativos por variables de entorno (`MODEL_CATALOG_JSON`, `EFFORT`, `DAILY_QUOTA_USD`, `RETENTION_DAYS`, ...); ver `docs/CONTRATO.md` §5–6.

En producción la API rechaza arrancar con `AUTH_MODE=dev`, `STORE_MODE=memory` o `LLM_MODE=fake`.

## Reglas que el código hace cumplir

- Sin `thinking` con presupuesto, sin `temperature/top_p/top_k`, sin prefill, sin `tool_choice` forzado (400 en Fable 5.1 / Opus 5); `output_config.effort` constante por conversación; prompt de sistema versionado por conversación con caché de 1 h.
- Rechazo del clasificador (`stop_reason: "refusal"`) ≠ indisponibilidad (429/5xx/403/404): dos mecanismos distintos, pin por conversación (permanente por rechazo, 15 min por disponibilidad), nunca se sustituye en silencio una respuesta ya emitida.
- Logs con lista blanca de claves; test automático de no fuga; auditoría por usuario sin contenido; títulos de conversación opacos; borrado explícito; cabecera `Clear-Site-Data` al cerrar sesión.
