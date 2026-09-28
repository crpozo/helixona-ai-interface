import { describe, expect, it } from "vitest";
import { DEFAULT_CATALOG } from "../src/catalog.js";
import { buildRequestBody, SdkProvider, THINKING_BINDING_BETA, toProviderModelId } from "../src/llm/sdk-provider.js";
import type { StreamParams } from "../src/llm/provider.js";

describe("SdkProvider", () => {
  it("traduce los IDs del catálogo según la plataforma", () => {
    expect(toProviderModelId("bedrock", "anthropic.claude-fable-5-1")).toBe("anthropic.claude-fable-5-1");
    expect(toProviderModelId("anthropic", "anthropic.claude-fable-5-1")).toBe("claude-fable-5-1");
    expect(toProviderModelId("claude-platform-aws", "anthropic.claude-opus-5")).toBe("claude-opus-5");
  });
  it("asks the API to drop thinking blocks whose earlier history changed, instead of failing the turn", () => {
    const params: StreamParams = { model: "anthropic.claude-sonnet-5-5", maxTokens: 64_000, effort: "medium", system: [{ type: "text", text: "system" }], messages: [{ role: "user", content: "Hello" }] };
    const body = buildRequestBody("anthropic", params);
    expect(body.model).toBe("claude-sonnet-5-5");
    expect(body.thinking).toEqual({ type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } });
    expect(body.betas).toEqual([THINKING_BINDING_BETA]);
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("tool_choice");
    // A summarized display is kept alongside the binding.
    const summarized = buildRequestBody("bedrock", { ...params, thinking: { type: "adaptive", display: "summarized" } });
    expect(summarized.model).toBe("anthropic.claude-sonnet-5-5");
    expect(summarized.thinking).toEqual({ type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } });
  });
  it("valida la configuración mínima de cada modo", () => {
    expect(() => new SdkProvider({ mode: "anthropic", catalog: DEFAULT_CATALOG })).toThrow(/apiKey/);
    expect(() => new SdkProvider({ mode: "claude-platform-aws", catalog: DEFAULT_CATALOG, awsRegion: "us-east-1" })).toThrow(/workspaceId/);
    expect(() => new SdkProvider({ mode: "bedrock", catalog: DEFAULT_CATALOG })).toThrow(/awsRegion/);
    expect(new SdkProvider({ mode: "anthropic", catalog: DEFAULT_CATALOG, apiKey: "sk-test" }).mode).toBe("anthropic");
  });
});
