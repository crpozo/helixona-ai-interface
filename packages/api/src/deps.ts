import type { Catalog, LlmProvider, ModelRouter, SafeLogger } from "@helixona/core";
import type { Config } from "./config.js";
import type { IdentityProvider } from "./auth/cognito.js";
import type { SessionService } from "./auth/session.js";
import type { Repos, UserDirectory } from "./repos/types.js";
import type { SystemPrompt } from "./system-prompt.js";
import type { AttachmentStore } from "./attachments/store.js";
import type { PasswordAuth } from "./auth/password.js";

export interface Deps {
  config: Config;
  log: SafeLogger;
  catalog: Catalog;
  repos: Repos;
  sessions: SessionService;
  identity: IdentityProvider;
  directory: UserDirectory;
  provider: LlmProvider;
  router: ModelRouter;
  systemPrompt: SystemPrompt;
  /** Attachment bytes (S3 in production, memory in dev/tests); null = uploads disabled. */
  attachments: AttachmentStore | null;
  /** In-app password sign-in (Cognito USER_PASSWORD_AUTH); null in dev mode. */
  passwordAuth: PasswordAuth | null;
  now?: () => Date;
}
