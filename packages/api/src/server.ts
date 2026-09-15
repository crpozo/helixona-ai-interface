import { randomBytes } from "node:crypto";
import { CircuitBreaker, createSafeLogger, FakeProvider, ModelRouter, parseCatalog, SdkProvider } from "@helixona/core";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { CognitoIdentityProvider, CognitoUserDirectory } from "./auth/cognito.js";
import { MemoryAttachmentStore, S3AttachmentStore } from "./attachments/store.js";
import { CognitoPasswordAuth } from "./auth/password.js";
import { DevIdentityProvider } from "./auth/dev.js";
import { SessionService } from "./auth/session.js";
import { dynamoRepos } from "./repos/dynamo.js";
import { memoryRepos, MemoryUserDirectory } from "./repos/memory.js";
import { loadSystemPrompt } from "./system-prompt.js";
import type { Deps } from "./deps.js";

export async function createDeps(env: NodeJS.ProcessEnv = process.env): Promise<Deps> {
  const config = loadConfig(env);
  const log = createSafeLogger({ level: config.LOG_LEVEL, strict: config.NODE_ENV !== "production" });
  const catalog = parseCatalog(config.MODEL_CATALOG_JSON);
  if (config.EFFORT) catalog.effort = config.EFFORT;
  const repos = config.STORE_MODE === "memory"
    ? memoryRepos()
    : dynamoRepos(config.AWS_REGION!, { conversations: config.TABLE_CONVERSATIONS!, messages: config.TABLE_MESSAGES!, sessions: config.TABLE_SESSIONS!, audit: config.TABLE_AUDIT!, usage: config.TABLE_USAGE!, projects: config.TABLE_PROJECTS! });
  const sessions = new SessionService({ repo: repos.sessions, secret: config.SESSION_SECRET ?? randomBytes(32).toString("base64url"), idleSeconds: config.SESSION_IDLE_SECONDS, absoluteSeconds: config.SESSION_ABSOLUTE_SECONDS });
  const identity = config.AUTH_MODE === "dev"
    ? new DevIdentityProvider()
    : new CognitoIdentityProvider({ region: config.COGNITO_REGION!, userPoolId: config.COGNITO_USER_POOL_ID!, clientId: config.COGNITO_CLIENT_ID!, clientSecret: config.COGNITO_CLIENT_SECRET!, domain: config.COGNITO_DOMAIN!, redirectUri: `${config.APP_BASE_URL}/api/auth/callback`, logoutUri: `${config.APP_BASE_URL}/login` });
  const directory = config.AUTH_MODE === "dev" ? new MemoryUserDirectory() : new CognitoUserDirectory(config.COGNITO_REGION!, config.COGNITO_USER_POOL_ID!);
  const provider = config.LLM_MODE === "fake"
    ? new FakeProvider({ refusalFallbacks: Object.fromEntries(catalog.models.map((m) => [m.modelId, m.refusalFallbacks])), delayMs: 15 })
    : new SdkProvider({ mode: config.LLM_MODE, catalog, awsRegion: config.AWS_REGION, apiKey: config.ANTHROPIC_API_KEY, workspaceId: config.ANTHROPIC_AWS_WORKSPACE_ID, timeoutMs: config.LLM_TIMEOUT_MS, logger: log });
  const router = new ModelRouter({ catalog, provider, breaker: new CircuitBreaker(), logger: log, maxTokens: config.MAX_TOKENS, thinkingDisplay: config.THINKING_DISPLAY, firstEventTimeoutMs: config.FIRST_EVENT_TIMEOUT_MS });
  const systemPrompt = loadSystemPrompt(config.SYSTEM_PROMPT_FILE, new URL("..", import.meta.url).pathname);
  const attachments = config.ATTACHMENTS_BUCKET
    ? new S3AttachmentStore(config.AWS_REGION!, config.ATTACHMENTS_BUCKET)
    : config.STORE_MODE === "memory" ? new MemoryAttachmentStore() : null;
  const passwordAuth = config.AUTH_MODE === "dev"
    ? null
    : new CognitoPasswordAuth({ region: config.COGNITO_REGION!, userPoolId: config.COGNITO_USER_POOL_ID!, clientId: config.COGNITO_CLIENT_ID!, clientSecret: config.COGNITO_CLIENT_SECRET! });
  return { config, log, catalog, repos, sessions, identity, directory, provider, router, systemPrompt, attachments, passwordAuth };
}

async function main() {
  const deps = await createDeps();
  const app = await buildApp(deps);
  await app.listen({ port: deps.config.PORT, host: deps.config.HOST });
  deps.log.info("server_started", { port: deps.config.PORT, mode: `${deps.config.AUTH_MODE}/${deps.config.STORE_MODE}/${deps.config.LLM_MODE}`, version: process.env["APP_VERSION"] ?? "dev" });
  const stop = async () => { await app.close(); process.exit(0); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => { process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
}
