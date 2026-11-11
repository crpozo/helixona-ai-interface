import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { SignatureV4 } from "@smithy/signature-v4";
import { sseTransport, type ResponsesTransport } from "@helixona/core";

/**
 * OpenAI's models on Amazon Bedrock, through its OpenAI-compatible Responses endpoint
 * (`https://bedrock-runtime.<region>.amazonaws.com/openai/v1/responses`). Requests are signed with the
 * task role (SigV4, service `bedrock`): no API key, nothing leaves AWS, and the clinic's AWS Business
 * Associate Addendum covers it. With `store: false` Bedrock keeps nothing from the request.
 */
export function bedrockOpenAiTransport(region: string, timeoutMs: number, fetchImpl?: typeof fetch): ResponsesTransport {
  const signer = new SignatureV4({ service: "bedrock", region, credentials: defaultProvider(), sha256: Sha256 });
  return sseTransport({
    url: `https://bedrock-runtime.${region}.amazonaws.com/openai/v1/responses`,
    timeoutMs,
    ...(fetchImpl ? { fetchImpl } : {}),
    headers: async (url, body) => {
      const u = new URL(url);
      const signed = await signer.sign({
        method: "POST",
        protocol: u.protocol,
        hostname: u.hostname,
        path: u.pathname,
        headers: { host: u.hostname, "content-type": "application/json", accept: "text/event-stream" },
        body,
      });
      const { host: _host, ...headers } = signed.headers;
      return headers;
    },
  });
}
