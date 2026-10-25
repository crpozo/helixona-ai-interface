import { describe, expect, it } from "vitest";
import { APIError } from "@anthropic-ai/sdk";
import { classifyError, userMessageFor } from "../src/errors.js";

function apiError(status: number, message: string) {
  return APIError.generate(status, { error: { type: "invalid_request_error", message } }, message, new Headers());
}

describe("classifyError", () => {
  it("a provider account out of credit is billing: no fallback, an alarm, a message naming the fix", () => {
    const c = classifyError(apiError(400, "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."));
    expect(c.kind).toBe("billing");
    expect(c.fallback).toBe(false);
    expect(c.alarm).toBe(true);
    expect(userMessageFor(c, false, "Carlos")).toMatch(/no credit left.*contact Carlos to add credit/);
  });
  it("the organization's monthly spend limit in the Console is billing, and the message says where to raise it", () => {
    const c = classifyError(apiError(400, "You have reached your specified API usage limits. You will regain access on Nov 1, 2026 at 00:00 UTC."));
    expect(c.kind).toBe("billing");
    expect(c.detail).toBe("spend_limit");
    expect(userMessageFor(c, false, "Carlos")).toMatch(/no credit left for this month.*contact Carlos to increase it/);
  });
  it("a 400 naming the model is a configuration problem with a long breaker, and the message says what the provider said", () => {
    const c = classifyError(apiError(400, "The requested model is not supported"));
    expect(c.kind).toBe("config");
    expect(c.breakerMs).toBe(60 * 60_000);
    expect(c.detail).toBe("no_access");
    expect(userMessageFor(c, false)).toMatch(/no access to the model/);
  });
  it("a disabled organization is named as such", () => {
    const c = classifyError(apiError(403, "This organization has been disabled."));
    expect(c.kind).toBe("config");
    expect(c.detail).toBe("organization_disabled");
    expect(userMessageFor(c, false)).toMatch(/account as disabled/);
  });
  it("an unknown model is named as such", () => {
    const c = classifyError(apiError(404, "model: claude-x not found"));
    expect(c.detail).toBe("model_not_found");
    expect(userMessageFor(c, false)).toMatch(/does not recognize the model/);
  });
  it("a rate limit says so, and says when the backup is paused", () => {
    const c = classifyError(apiError(429, "Rate limit exceeded"));
    expect(c.kind).toBe("availability");
    expect(userMessageFor(c, false)).toMatch(/rate-limiting/);
    expect(userMessageFor(c, true)).toMatch(/backup model is paused/);
  });
  it("an overloaded provider is a plain availability failure", () => {
    const c = classifyError(apiError(529, "Overloaded"));
    expect(c.kind).toBe("availability");
    expect(userMessageFor(c, false)).toMatch(/overloaded/);
  });
});
