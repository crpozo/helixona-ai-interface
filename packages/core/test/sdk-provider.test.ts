import { describe, expect, it } from "vitest";
import { DEFAULT_CATALOG } from "../src/catalog.js";
import { SdkProvider, toProviderModelId } from "../src/llm/sdk-provider.js";

describe("SdkProvider", () => {
  it("traduce los IDs del catálogo según la plataforma", () => {
    expect(toProviderModelId("bedrock", "anthropic.claude-fable-5-1")).toBe("anthropic.claude-fable-5-1");
    expect(toProviderModelId("anthropic", "anthropic.claude-fable-5-1")).toBe("claude-fable-5-1");
    expect(toProviderModelId("claude-platform-aws", "anthropic.claude-opus-5")).toBe("claude-opus-5");
  });
  it("valida la configuración mínima de cada modo", () => {
    expect(() => new SdkProvider({ mode: "anthropic", catalog: DEFAULT_CATALOG })).toThrow(/apiKey/);
    expect(() => new SdkProvider({ mode: "claude-platform-aws", catalog: DEFAULT_CATALOG, awsRegion: "us-east-1" })).toThrow(/workspaceId/);
    expect(() => new SdkProvider({ mode: "bedrock", catalog: DEFAULT_CATALOG })).toThrow(/awsRegion/);
    expect(new SdkProvider({ mode: "anthropic", catalog: DEFAULT_CATALOG, apiKey: "sk-test" }).mode).toBe("anthropic");
  });
});
