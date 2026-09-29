import { describe, expect, it } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Conversation, StoredMessage } from "@helixona/core";
import { DynamoConversationRepo, DynamoMessageRepo } from "../src/repos/dynamo.js";

/** A client that records what would be written. */
function fakeClient() {
  const items: Array<Record<string, unknown>> = [];
  const doc = { send: async (cmd: { input: { Item?: Record<string, unknown> } }) => { if (cmd.input.Item) items.push(cmd.input.Item); return {}; } } as unknown as DynamoDBDocumentClient;
  return { doc, items };
}
const conversation: Conversation = {
  id: "01HZZZZZZZZZZZZZZZZZZZZZZZ", userId: "u1", title: "t", modelAlias: "sonnet", modelId: "m", pinnedModel: null, pinReason: null, pinnedUntil: null,
  systemPromptVersion: "v1", createdAt: "2026-03-01T00:00:00.000Z", updatedAt: "2026-03-01T00:00:00.000Z", messageCount: 0, lastInputTokens: 0, projectId: null,
};
const message: StoredMessage = { id: "m1", conversationId: conversation.id, seq: 1, role: "user", content: [{ type: "text", text: "hi" }], model: null, fallbackReason: null, stopReason: null, usage: null, createdAt: "2026-03-01T00:00:00.000Z" };

describe("Retention in DynamoDB", () => {
  it("gives every conversation and message an expiry, except an archived one (kept until deleted by hand)", async () => {
    const { doc, items } = fakeClient();
    const conversations = new DynamoConversationRepo(doc, "c");
    const messages = new DynamoMessageRepo(doc, "m");
    const before = Math.floor(Date.now() / 1000);
    await conversations.create(conversation, 30 * 86400);
    await messages.append(message, 30 * 86400);
    await conversations.create({ ...conversation, id: "01HZZZZZZZZZZZZZZZZZZZZZZ2", archived: true }, null);
    await messages.append({ ...message, id: "m2" }, null);
    expect(items[0]!.expiresAt).toBeGreaterThanOrEqual(before + 30 * 86400);
    expect(items[1]!.expiresAt).toBeGreaterThanOrEqual(before + 30 * 86400);
    expect(items[2]).not.toHaveProperty("expiresAt");
    expect(items[2]!.archived).toBe(true);
    expect(items[3]).not.toHaveProperty("expiresAt");
  });
});
