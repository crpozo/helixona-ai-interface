# Contrato técnico compartido (API, SSE, configuración, datos)

Este documento es la fuente de verdad entre `packages/core`, `packages/api`, `packages/web` y `packages/infra`. Si algo cambia aquí, cambia en los cuatro.

## 1. Principios
- Un solo contenedor (Node 22, Fastify) sirve la API en `/api/*` y la SPA compilada (`packages/web/dist`) en `/`. CloudFront → ALB → Fargate. Sin CORS: mismo origen.
- Nunca PHI en logs, URLs, títulos, métricas ni errores. Los ids son ULID opacos.
- Sesión del lado servidor; el navegador solo tiene una cookie opaca `hx_session` (`HttpOnly; Secure; SameSite=Lax; Path=/`).
- CSRF: toda petición mutante (`POST/PUT/PATCH/DELETE`) debe llevar la cabecera `X-Requested-With: helixona`; si falta → `403 {error:{code:"csrf"}}`.
- Todas las respuestas de error: `{ "error": { "code": string, "message": string } }` (mensaje genérico, sin contenido).
- Roles: `staff` (usa el chat) y `admin` (staff + administración).

## 2. Rutas REST (`/api`)

| Método | Ruta | Auth | Cuerpo / query | Respuesta |
|---|---|---|---|---|
| GET | `/api/health` | no | — | `{ ok: true, version }` |
| GET | `/api/auth/login` | no | — | 302 a Cognito (Authorization Code + PKCE). En `AUTH_MODE=dev`, 302 a `/login` |
| GET | `/api/auth/callback` | no | `?code&state` | Crea sesión, cookie, 302 a `/` |
| POST | `/api/auth/dev-login` | no (solo `AUTH_MODE=dev`) | `{ username, role? }` | `{ ok: true }` + cookie. En producción → 404 |
| POST | `/api/auth/logout` | sí | — | Borra sesión, revoca refresh token, `{ logoutUrl }` (Cognito `/logout` o `/login`) |
| GET | `/api/me` | sí | — | ver §3 |
| GET | `/api/conversations` | sí | — | `{ items: Conversation[] }` (solo del usuario, más reciente primero) |
| POST | `/api/conversations` | sí | `{ modelAlias }` | `Conversation` (201) |
| GET | `/api/conversations/:id` | sí | — | `{ conversation: Conversation, messages: Message[] }` |
| PATCH | `/api/conversations/:id` | sí | `{ title }` (máx 80 chars; se guarda cifrado como contenido) | `Conversation` |
| DELETE | `/api/conversations/:id` | sí | — | 204 (borrado explícito de mensajes y conversación) |
| POST | `/api/conversations/:id/messages` | sí | `{ text }` (1..20000 chars) | **SSE** (§4) |
| GET | `/api/admin/users` | admin | — | `{ items: AdminUser[] }` |
| POST | `/api/admin/users` | admin | `{ email, name, role }` | `AdminUser` (201) |
| POST | `/api/admin/users/:id/disable` | admin | — | `{ ok: true }` (deshabilita en Cognito y borra sus sesiones) |
| POST | `/api/admin/users/:id/enable` | admin | — | `{ ok: true }` |
| GET | `/api/admin/audit` | admin | `?day=YYYY-MM-DD` | `{ items: AuditEvent[] }` |
| GET | `/api/admin/usage` | admin | `?day=YYYY-MM-DD` | `{ items: UsageRow[] }` |

### Tipos
```ts
type ModelAlias = "sonnet" | "opus" | "fable"; // el catálogo puede añadir otros

interface CatalogModel { alias: string; modelId: string; label: string; description: string; costFactor: number; available: boolean }

interface Me {
  user: { id: string; email: string; name: string; roles: ("staff"|"admin")[] };
  session: { expiresAt: string; idleTimeoutSeconds: number };
  catalog: { defaultAlias: string; effort: "low"|"medium"|"high"|"xhigh"|"max"; models: CatalogModel[] };
  limits: { maxMessageChars: number; contextLimitTokens: number };
}

interface Conversation {
  id: string; title: string;            // título opaco por defecto ("Conversación 12 sep 10:32")
  modelAlias: string; modelId: string;  // elegido al crear; fijo
  pinnedModel: string | null;           // modelo que sirve tras un fallback (null = modelId)
  pinReason: "refusal" | "availability" | null;
  createdAt: string; updatedAt: string; messageCount: number;
}

interface Message {
  id: string; role: "user" | "assistant";
  content: ContentBlock[];              // bloques tal cual la API (text, thinking, fallback, ...)
  model: string | null;                 // modelo que sirvió (assistant)
  fallbackReason: "refusal" | "availability" | null;
  stopReason: string | null;
  usage: Usage | null; createdAt: string;
}
interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; estimatedUsd: number }

interface AdminUser { id: string; email: string; name: string; role: "staff"|"admin"; enabled: boolean; createdAt: string }
interface AuditEvent { id: string; ts: string; userId: string; action: string; conversationId?: string; model?: string; servedBy?: string; fallbackReason?: string; refusalCategory?: string|null; stopReason?: string; usage?: Usage; latencyMs?: number; meta?: Record<string, string|number|boolean> }
interface UsageRow { userId: string; day: string; turns: number; inputTokens: number; outputTokens: number; estimatedUsd: number; byModel: Record<string, { turns: number; estimatedUsd: number }> }
```

Acciones de auditoría: `login`, `logout`, `session_expired`, `conversation_create`, `conversation_read`, `conversation_delete`, `conversation_title`, `turn` (con model/servedBy/fallbackReason/refusalCategory/stopReason/usage/latencyMs), `turn_error`, `admin_user_create`, `admin_user_disable`, `admin_user_enable`, `admin_audit_read`, `quota_exceeded`.

## 3. Cabeceras de seguridad (las pone la API en todas las respuestas)
```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Cache-Control: no-store   (en /api/*)
Permissions-Policy: camera=(), microphone=(), geolocation=()
```
La SPA no puede cargar scripts, fuentes ni imágenes remotas. Todo se empaqueta con Vite (sin `unsafe-inline` en scripts).

## 4. Streaming SSE de `POST /api/conversations/:id/messages`
`Content-Type: text/event-stream`. Cada evento: `event: <tipo>\ndata: <json>\n\n`. Comentario `: ping` cada 15 s. El cliente lo consume con `fetch` + `ReadableStream` (no `EventSource`, porque es POST).

| Evento | data | Cuándo |
|---|---|---|
| `message_start` | `{ userMessageId, assistantMessageId, model }` | Al iniciar el turno (modelo solicitado) |
| `text_delta` | `{ text }` | Texto de la respuesta |
| `thinking_delta` | `{ text }` | Solo si `THINKING_DISPLAY=summarized` |
| `fallback` | `{ from, to, reason: "refusal" }` | Cambio de modelo por rechazo (el texto ya emitido se conserva; el nuevo modelo continúa) |
| `model_switched` | `{ from, to, reason: "availability" }` | Cambio por indisponibilidad antes de emitir texto |
| `refused` | `{ category: string \| null }` | Toda la cadena rechazó. El cliente descarta lo parcial y muestra mensaje neutro |
| `error` | `{ code, message, retryable: boolean, partial: boolean }` | Error; `partial=true` = se emitió texto y no se sustituye; ofrecer "Reintentar" |
| `done` | `{ assistantMessageId, model, stopReason, usage, fallbackReason }` | Fin. `stopReason="max_tokens"` = respuesta truncada (mostrar aviso) |

Códigos de `error`: `quota_exceeded`, `context_limit`, `model_unavailable`, `bad_request`, `internal`.

## 5. Variables de entorno de la API
| Variable | Default | Uso |
|---|---|---|
| `NODE_ENV` | `development` | `production` desactiva los modos dev |
| `PORT` | `3000` | |
| `APP_BASE_URL` | `http://localhost:3000` | Redirecciones OIDC |
| `AUTH_MODE` | `cognito` | `cognito` \| `dev` (rechazado en producción) |
| `COGNITO_REGION`, `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `COGNITO_CLIENT_SECRET`, `COGNITO_DOMAIN` | — | `COGNITO_DOMAIN` = `https://<prefijo>.auth.<region>.amazoncognito.com`. El secret llega como secreto de ECS |
| `SESSION_IDLE_SECONDS` | `900` | Inactividad |
| `SESSION_ABSOLUTE_SECONDS` | `43200` | Máximo absoluto |
| `SESSION_SECRET` | — | Clave HMAC para firmar el id de sesión (secreto de ECS) |
| `STORE_MODE` | `dynamo` | `dynamo` \| `memory` |
| `TABLE_CONVERSATIONS`, `TABLE_MESSAGES`, `TABLE_SESSIONS`, `TABLE_AUDIT`, `TABLE_USAGE` | — | Nombres de tablas |
| `AWS_REGION` | — | Región de Bedrock y DynamoDB |
| `LLM_MODE` | `bedrock` | `bedrock` \| `anthropic` \| `claude-platform-aws` \| `fake`. `anthropic` usa la Claude API con `ANTHROPIC_API_KEY` (secreto); `claude-platform-aws` usa SigV4 + `ANTHROPIC_AWS_WORKSPACE_ID`. El catálogo se escribe siempre con IDs de Bedrock (`anthropic.claude-opus-5`); los otros modos quitan el prefijo |
| `MODEL_CATALOG_JSON` | catálogo por defecto (§6) | JSON completo del catálogo |
| `SYSTEM_PROMPT_FILE` | `prompts/system.es.md` | Prompt de sistema (versionado por conversación) |
| `EFFORT` | `medium` | `output_config.effort` |
| `MAX_TOKENS` | `64000` | Streaming |
| `THINKING_DISPLAY` | `omitted` | `omitted` \| `summarized` |
| `CONTEXT_LIMIT_TOKENS` | `150000` | Al superarlo, `error: context_limit` y sugerir nueva conversación |
| `DAILY_QUOTA_USD` | `10` | Por usuario y día (estimado con precios del catálogo) |
| `RETENTION_DAYS` | `30` | TTL de conversaciones/mensajes |
| `FIRST_EVENT_TIMEOUT_MS` | `60000` | Sin primer evento → fallback por disponibilidad |
| `LLM_TIMEOUT_MS` | `600000` | Timeout del SDK |
| `LOG_LEVEL` | `info` | |

## 6. Catálogo de modelos (JSON)
```json
{
  "defaultAlias": "opus",
  "effort": "medium",
  "models": [
    { "alias": "sonnet", "modelId": "anthropic.claude-sonnet-5", "label": "Sonnet", "description": "Rápido y económico: traducciones, cartas, resúmenes cortos", "costFactor": 1, "priceInPerM": 2, "priceOutPerM": 10, "priceCacheReadPerM": 0.2, "priceCacheWritePerM": 2.5, "refusalFallbacks": [], "availabilityFallbacks": [], "roles": ["staff", "admin"] },
    { "alias": "opus", "modelId": "anthropic.claude-opus-5", "label": "Opus", "description": "Equilibrio recomendado para el trabajo diario", "costFactor": 2.5, "priceInPerM": 5, "priceOutPerM": 25, "priceCacheReadPerM": 0.5, "priceCacheWritePerM": 6.25, "refusalFallbacks": ["anthropic.claude-opus-4-8"], "availabilityFallbacks": [], "roles": ["staff", "admin"] },
    { "alias": "fable", "modelId": "anthropic.claude-fable-5-1", "label": "Fable", "description": "Máxima capacidad para tareas difíciles y documentos largos (más lento y costoso)", "costFactor": 5, "priceInPerM": 10, "priceOutPerM": 50, "priceCacheReadPerM": 0.25, "priceCacheWritePerM": 12.5, "refusalFallbacks": ["anthropic.claude-opus-5"], "availabilityFallbacks": ["anthropic.claude-opus-5"], "roles": ["staff", "admin"] }
  ],
  "fallbackModels": [
    { "modelId": "anthropic.claude-opus-4-8", "label": "Opus 4.8", "priceInPerM": 5, "priceOutPerM": 25, "priceCacheReadPerM": 0.5, "priceCacheWritePerM": 6.25 }
  ]
}
```
Precios: referencia 1P en USD por millón de tokens; la tarifa de Bedrock se ajusta en este JSON. `roles` restringe qué roles ven el modelo. `fallbackModels` describe modelos no seleccionables que solo sirven como respaldo (etiqueta y precio); todo respaldo debe existir en `models` o en `fallbackModels` y nunca puede ser el propio modelo. La validación del catálogo (`packages/core/src/catalog.ts`) rechaza catálogos inconsistentes al arrancar.

Los mensajes del usuario y del asistente se persisten solo cuando el turno termina bien; si toda la cadena rechaza o hay error, no se guarda nada y "Reintentar" en la UI reenvía el texto como un turno nuevo.

## 7. Tablas DynamoDB (todas con SSE-KMS con la CMK `phi-data`, PITR activado, `deletionProtection`)
| Tabla | PK | SK | TTL | GSI | Notas |
|---|---|---|---|---|---|
| `conversations` | `userId` (S) | `conversationId` (S) | `expiresAt` (N, epoch s) | — | Atributos: title (cifrado a nivel de app opcional), modelAlias, modelId, pinnedModel, pinReason, systemPromptVersion, createdAt, updatedAt, messageCount |
| `messages` | `conversationId` (S) | `seq` (S, `000001`) | `expiresAt` | — | role, content (JSON), model, fallbackReason, stopReason, usage, createdAt |
| `sessions` | `sessionId` (S) | — | `expiresAt` | `byUser`: PK `userId` | userId, roles, createdAt, lastSeenAt, absoluteExpiresAt, refreshToken |
| `audit` | `day` (S, YYYY-MM-DD) | `sk` (S, `ts#ulid`) | — (retención larga; export a S3 Object Lock) | `byUser`: PK `userId`, SK `sk` | Sin contenido. El rol de la tarea solo tiene `PutItem` y `Query` (sin Update/Delete) |
| `usage` | `userId` (S) | `day` (S) | `expiresAt` (400 días) | — | Acumuladores por modelo |

## 8. Infra: lo que la app espera del entorno
- Rol de tarea ECS con: `bedrock:InvokeModel*` sobre los ARNs de los modelos del catálogo (y perfiles `us.` si aplican), DynamoDB sobre las 5 tablas (audit: solo Put/Query), `kms:Decrypt/GenerateDataKey` sobre la CMK, `cognito-idp:AdminCreateUser/AdminDisableUser/AdminEnableUser/ListUsers/AdminRevokeToken/RevokeToken` sobre el User Pool, Logs a su grupo.
- Secretos de ECS desde Secrets Manager: `SESSION_SECRET`, `COGNITO_CLIENT_SECRET`.
- ALB: `idle_timeout` 600 s, target group HTTPS (TLS hasta el contenedor), health check `GET /api/health`.
- CloudFront: origen ALB con cabecera secreta `X-Origin-Verify`, Price Class Norteamérica, `origin_read_timeout` 60 s con heartbeats cada 15 s; WAF con Core Rule Set en modo *count* sobre `/api/conversations/*/messages`, campos redactados (Authorization, cookie), rate limit alto por IP.
- Cognito: sin autoregistro, MFA TOTP obligatoria, contraseña 12+, app client confidencial, callback `${APP_BASE_URL}/api/auth/callback`, logout `${APP_BASE_URL}/login`, grupos `staff` y `admin`, WAF asociado.
- Sin model invocation logging de Bedrock (SCP que lo deniega).
