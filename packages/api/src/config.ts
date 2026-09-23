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
  TABLE_PROJECTS: z.string().optional(),
  TABLE_TRAINING: z.string().optional(),
  AWS_REGION: z.string().optional(),
  LLM_MODE: z.enum(["bedrock", "anthropic", "claude-platform-aws", "fake"]).default("bedrock"),
  /** Dev only: delay between simulated tokens of the fake provider (slower = easier to test streaming UI). */
  FAKE_DELAY_MS: z.coerce.number().int().nonnegative().default(15),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_AWS_WORKSPACE_ID: z.string().optional(),
  MODEL_CATALOG_JSON: z.string().optional(),
  SYSTEM_PROMPT_FILE: z.string().default("prompts/system.en.md"),
  EFFORT: EffortSchema.optional(),
  MAX_TOKENS: z.coerce.number().int().positive().default(64000),
  THINKING_DISPLAY: z.enum(["omitted", "summarized"]).default("omitted"),
  CONTEXT_LIMIT_TOKENS: z.coerce.number().int().positive().default(150000),
  DAILY_QUOTA_USD: z.coerce.number().nonnegative().default(10),
  RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  /** Nobody, administrators included, uses the assistant before completing the workforce training. */
  TRAINING_REQUIRED: z.enum(["true", "false"]).default("true"),
  /** Lets a user skip the online training by attesting they already know it; the log shows the attestation. */
  TRAINING_ALLOW_SKIP: z.enum(["true", "false"]).default("true"),
  FIRST_EVENT_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(600000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  MAX_MESSAGE_CHARS: z.coerce.number().int().positive().default(20000),
  WEB_DIST: z.string().optional(),
  RATE_LIMIT_TURNS_PER_HOUR: z.coerce.number().int().positive().default(120),
  /** S3 bucket for attachments; unset = uploads disabled (dev with STORE_MODE=memory keeps them in memory). */
  ATTACHMENTS_BUCKET: z.string().optional(),
  /** SNS topic that emails bug reports to the maintainer; unset = reports kept in memory (dev) or disabled. */
  FEEDBACK_TOPIC_ARN: z.string().optional(),
  MAX_ATTACHMENT_MB: z.coerce.number().positive().default(20),
  MAX_ATTACHMENTS_PER_MESSAGE: z.coerce.number().int().positive().default(5),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = Env.parse(env);
  const prod = cfg.NODE_ENV === "production";
  if (prod && cfg.AUTH_MODE === "dev") throw new Error("AUTH_MODE=dev is not allowed in production");
  if (prod && cfg.STORE_MODE === "memory") throw new Error("STORE_MODE=memory is not allowed in production");
  if (prod && cfg.LLM_MODE === "fake") throw new Error("LLM_MODE=fake is not allowed in production");
  if (prod && !cfg.APP_BASE_URL.startsWith("https://")) throw new Error("APP_BASE_URL must use https in production");
  if (cfg.AUTH_MODE === "cognito") {
    for (const k of ["COGNITO_REGION", "COGNITO_USER_POOL_ID", "COGNITO_CLIENT_ID", "COGNITO_CLIENT_SECRET", "COGNITO_DOMAIN"] as const) {
      if (!cfg[k]) throw new Error(`${k} is required for AUTH_MODE=cognito`);
    }
  }
  if (cfg.STORE_MODE === "dynamo") {
    for (const k of ["TABLE_CONVERSATIONS", "TABLE_MESSAGES", "TABLE_SESSIONS", "TABLE_AUDIT", "TABLE_USAGE", "TABLE_PROJECTS", "TABLE_TRAINING", "AWS_REGION"] as const) {
      if (!cfg[k]) throw new Error(`${k} is required for STORE_MODE=dynamo`);
    }
  }
  if (cfg.LLM_MODE === "bedrock" && !cfg.AWS_REGION) throw new Error("AWS_REGION is required for LLM_MODE=bedrock");
  if (cfg.ATTACHMENTS_BUCKET && !cfg.AWS_REGION) throw new Error("AWS_REGION is required when ATTACHMENTS_BUCKET is set");
  if (cfg.FEEDBACK_TOPIC_ARN && !cfg.AWS_REGION) throw new Error("AWS_REGION is required when FEEDBACK_TOPIC_ARN is set");
  if (cfg.LLM_MODE === "anthropic" && !cfg.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required for LLM_MODE=anthropic");
  if (cfg.LLM_MODE === "claude-platform-aws" && (!cfg.AWS_REGION || !cfg.ANTHROPIC_AWS_WORKSPACE_ID)) throw new Error("AWS_REGION and ANTHROPIC_AWS_WORKSPACE_ID are required for LLM_MODE=claude-platform-aws");
  if (!cfg.SESSION_SECRET) {
    if (prod) throw new Error("SESSION_SECRET is required");
  }
  return cfg;
}
