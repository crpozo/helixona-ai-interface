import { z } from "zod";
import { EffortSchema } from "@helixona/core";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  AUTH_MODE: z.enum(["cognito", "dev"]).default("cognito"),
  COGNITO_REGION: z.string().optional(),
  COGNITO_USER_POOL_ID: z.string().optional(),
  COGNITO_CLIENT_ID: z.string().optional(),
  COGNITO_CLIENT_SECRET: z.string().optional(),
  COGNITO_DOMAIN: z.string().url().optional(),
  SESSION_IDLE_SECONDS: z.coerce.number().int().positive().default(900),
  SESSION_ABSOLUTE_SECONDS: z.coerce.number().int().positive().default(43200),
  SESSION_SECRET: z.string().min(16).optional(),
  STORE_MODE: z.enum(["dynamo", "memory"]).default("dynamo"),
  TABLE_CONVERSATIONS: z.string().optional(),
  TABLE_MESSAGES: z.string().optional(),
  TABLE_SESSIONS: z.string().optional(),
  TABLE_AUDIT: z.string().optional(),
  TABLE_USAGE: z.string().optional(),
  AWS_REGION: z.string().optional(),
  LLM_MODE: z.enum(["bedrock", "fake"]).default("bedrock"),
  MODEL_CATALOG_JSON: z.string().optional(),
  SYSTEM_PROMPT_FILE: z.string().default("prompts/system.es.md"),
  EFFORT: EffortSchema.optional(),
  MAX_TOKENS: z.coerce.number().int().positive().default(64000),
  THINKING_DISPLAY: z.enum(["omitted", "summarized"]).default("omitted"),
  CONTEXT_LIMIT_TOKENS: z.coerce.number().int().positive().default(150000),
  DAILY_QUOTA_USD: z.coerce.number().nonnegative().default(10),
  RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  FIRST_EVENT_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(600000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  MAX_MESSAGE_CHARS: z.coerce.number().int().positive().default(20000),
  WEB_DIST: z.string().optional(),
  RATE_LIMIT_TURNS_PER_HOUR: z.coerce.number().int().positive().default(120),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = Env.parse(env);
  const prod = cfg.NODE_ENV === "production";
  if (prod && cfg.AUTH_MODE === "dev") throw new Error("AUTH_MODE=dev no está permitido en producción");
  if (prod && cfg.STORE_MODE === "memory") throw new Error("STORE_MODE=memory no está permitido en producción");
  if (prod && cfg.LLM_MODE === "fake") throw new Error("LLM_MODE=fake no está permitido en producción");
  if (prod && !cfg.APP_BASE_URL.startsWith("https://")) throw new Error("APP_BASE_URL debe ser https en producción");
  if (cfg.AUTH_MODE === "cognito") {
    for (const k of ["COGNITO_REGION", "COGNITO_USER_POOL_ID", "COGNITO_CLIENT_ID", "COGNITO_CLIENT_SECRET", "COGNITO_DOMAIN"] as const) {
      if (!cfg[k]) throw new Error(`falta ${k} para AUTH_MODE=cognito`);
    }
  }
  if (cfg.STORE_MODE === "dynamo") {
    for (const k of ["TABLE_CONVERSATIONS", "TABLE_MESSAGES", "TABLE_SESSIONS", "TABLE_AUDIT", "TABLE_USAGE", "AWS_REGION"] as const) {
      if (!cfg[k]) throw new Error(`falta ${k} para STORE_MODE=dynamo`);
    }
  }
  if (cfg.LLM_MODE === "bedrock" && !cfg.AWS_REGION) throw new Error("falta AWS_REGION para LLM_MODE=bedrock");
  if (!cfg.SESSION_SECRET) {
    if (prod) throw new Error("falta SESSION_SECRET");
  }
  return cfg;
}
