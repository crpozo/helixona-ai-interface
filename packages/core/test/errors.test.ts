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
    expect(userMessageFor(c, false)).toMatch(/run out of credit/);
  });
  it("a 400 naming the model is a configuration problem with a long breaker", () => {
    const c = classifyError(apiError(400, "The requested model is not supported"));
    expect(c.kind).toBe("config");
    expect(c.breakerMs).toBe(60 * 60_000);
    expect(userMessageFor(c, false)).toMatch(/configuration/);
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
