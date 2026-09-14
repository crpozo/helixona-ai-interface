import type { Catalog } from "../catalog.js";
import type { SafeLogger } from "../logger.js";
import { SdkProvider } from "./sdk-provider.js";

export interface BedrockProviderOptions { awsRegion: string; catalog: Catalog; timeoutMs?: number; maxRetries?: number; logger?: SafeLogger }

/** Amazon Bedrock (endpoint Mantle). Atajo de `SdkProvider` con `mode: "bedrock"`. */
export class BedrockProvider extends SdkProvider {
  constructor(opts: BedrockProviderOptions) { super({ mode: "bedrock", ...opts }); }
}
