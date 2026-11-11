import { randomBytes } from "node:crypto";
import { bedrockOpenAiModelId, CircuitBreaker, createSafeLogger, FakeProvider, ModelRouter, OpenAiProvider, parseCatalog, RoutedProvider, SdkProvider, withOpenAi } from "@helixona/core";
import { bedrockOpenAiTransport } from "./bedrock-openai.js";
import { buildApp } from "./app.js";
import { drainTurns } from "./routes/chat.js";
import { loadConfig } from "./config.js";
import { CognitoIdentityProvider, CognitoUserDirectory } from "./auth/cognito.js";
import { MemoryAttachmentStore, S3AttachmentStore } from "./attachments/store.js";
import { CognitoPasswordAuth } from "./auth/password.js";
import { DevIdentityProvider } from "./auth/dev.js";
import { MemoryFeedbackSender, SnsFeedbackSender } from "./feedback.js";
import { AnthropicBilling, isConfiguredKey } from "./billing/anthropic.js";
import { SessionService } from "./auth/session.js";
import { dynamoRepos } from "./repos/dynamo.js";
import { memoryRepos, MemoryUserDirectory } from "./repos/memory.js";
import { loadSystemPrompt } from "./system-prompt.js";
import type { Deps } from "./deps.js";

export async function createDeps(env: NodeJS.ProcessEnv = process.env): Promise<Deps> {
  const config = loadConfig(env);
  const log = createSafeLogger({ level: config.LOG_LEVEL, strict: config.NODE_ENV !== "production" });
  // OpenAI's models join the catalog when they are served by Amazon Bedrock (the task role, under the
  // AWS agreement) or, failing that, when the server holds an OpenAI key of its own.
  const openAiBedrock = config.OPENAI_VIA_BEDROCK === "true" && !!config.AWS_REGION;
  const openAiKey = !openAiBedrock && isConfiguredKey(config.OPENAI_API_KEY) ? config.OPENAI_API_KEY : null;
  const catalog = openAiBedrock ? withOpenAi(parseCatalog(config.MODEL_CATALOG_JSON), "bedrock") : openAiKey ? withOpenAi(parseCatalog(config.MODEL_CATALOG_JSON)) : parseCatalog(config.MODEL_CATALOG_JSON);
  if (config.EFFORT) catalog.effort = config.EFFORT;
  const repos = config.STORE_MODE === "memory"
    ? memoryRepos()
    : dynamoRepos(config.AWS_REGION!, { conversations: config.TABLE_CONVERSATIONS!, messages: config.TABLE_MESSAGES!, sessions: config.TABLE_SESSIONS!, audit: config.TABLE_AUDIT!, usage: config.TABLE_USAGE!, projects: config.TABLE_PROJECTS!, training: config.TABLE_TRAINING!, settings: config.TABLE_SETTINGS! });
  const sessions = new SessionService({ repo: repos.sessions, secret: config.SESSION_SECRET ?? randomBytes(32).toString("base64url"), idleSeconds: config.SESSION_IDLE_SECONDS, absoluteSeconds: config.SESSION_ABSOLUTE_SECONDS });
  const identity = config.AUTH_MODE === "dev"
    ? new DevIdentityProvider()
    : new CognitoIdentityProvider({ region: config.COGNITO_REGION!, userPoolId: config.COGNITO_USER_POOL_ID!, clientId: config.COGNITO_CLIENT_ID!, clientSecret: config.COGNITO_CLIENT_SECRET!, domain: config.COGNITO_DOMAIN!, redirectUri: `${config.APP_BASE_URL}/api/auth/callback`, logoutUri: `${config.APP_BASE_URL}/login` });
  const directory = config.AUTH_MODE === "dev" ? new MemoryUserDirectory() : new CognitoUserDirectory(config.COGNITO_REGION!, config.COGNITO_USER_POOL_ID!);
  const provider = config.LLM_MODE === "fake"
    ? new FakeProvider({ refusalFallbacks: Object.fromEntries(catalog.models.map((m) => [m.modelId, m.refusalFallbacks])), delayMs: config.FAKE_DELAY_MS })
    : new RoutedProvider(
        new SdkProvider({ mode: config.LLM_MODE, catalog, awsRegion: config.AWS_REGION, apiKey: config.ANTHROPIC_API_KEY, workspaceId: config.ANTHROPIC_AWS_WORKSPACE_ID, timeoutMs: config.LLM_TIMEOUT_MS, logger: log }),
        openAiBedrock
          ? new OpenAiProvider({ transport: bedrockOpenAiTransport(config.AWS_REGION!, config.LLM_TIMEOUT_MS), wireModel: bedrockOpenAiModelId, logger: log })
          : openAiKey ? new OpenAiProvider({ apiKey: openAiKey, timeoutMs: config.LLM_TIMEOUT_MS, logger: log }) : null,
      );
  const router = new ModelRouter({ catalog, provider, breaker: new CircuitBreaker(), logger: log, maxTokens: config.MAX_TOKENS, thinkingDisplay: config.THINKING_DISPLAY, firstEventTimeoutMs: config.FIRST_EVENT_TIMEOUT_MS, contextLimitTokens: config.CONTEXT_LIMIT_TOKENS, adminContact: config.ADMIN_CONTACT });
  const systemPrompt = loadSystemPrompt(config.SYSTEM_PROMPT_FILE, new URL("..", import.meta.url).pathname);
  const attachments = config.ATTACHMENTS_BUCKET
    ? new S3AttachmentStore(config.AWS_REGION!, config.ATTACHMENTS_BUCKET)
    : config.STORE_MODE === "memory" ? new MemoryAttachmentStore() : null;
  const passwordAuth = config.AUTH_MODE === "dev"
    ? null
    : new CognitoPasswordAuth({ region: config.COGNITO_REGION!, userPoolId: config.COGNITO_USER_POOL_ID!, clientId: config.COGNITO_CLIENT_ID!, clientSecret: config.COGNITO_CLIENT_SECRET! });
  const feedback = config.FEEDBACK_TOPIC_ARN
    ? new SnsFeedbackSender(config.AWS_REGION!, config.FEEDBACK_TOPIC_ARN, config.FEEDBACK_EMAIL)
    : config.STORE_MODE === "memory" ? new MemoryFeedbackSender(config.FEEDBACK_EMAIL || "maintainer@example.test") : null;
  // The billed cost report for the billing view, when the organization's Admin API key is in Secrets Manager.
  const billing = isConfiguredKey(config.ANTHROPIC_ADMIN_API_KEY) ? new AnthropicBilling({ apiKey: config.ANTHROPIC_ADMIN_API_KEY, log }) : null;
  return { config, log, catalog, repos, sessions, identity, directory, provider, router, systemPrompt, attachments, passwordAuth, feedback, billing };
}

async function main() {
  const deps = await createDeps();
  const app = await buildApp(deps);
  await app.listen({ port: deps.config.PORT, host: deps.config.HOST });
  deps.log.info("server_started", { port: deps.config.PORT, mode: `${deps.config.AUTH_MODE}/${deps.config.STORE_MODE}/${deps.config.LLM_MODE}`, version: process.env["APP_VERSION"] ?? "dev" });
  // ECS sends SIGTERM and, after the task's stop timeout (120 s), SIGKILL. Turns in flight get most of
  // that to finish; the rest are handed back to their senders, who retry on the new container.
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const left = await drainTurns(deps.config.NODE_ENV === "production" ? 100_000 : 2_000);
    if (left > 0) deps.log.warn("shutdown_turns_restarted", { count: left });
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop()); process.on("SIGINT", () => void stop());
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => { process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
}
