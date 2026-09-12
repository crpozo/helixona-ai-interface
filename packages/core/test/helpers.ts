import type { Conversation, StoredMessage, TurnEvent } from "../src/types.js";
import { DEFAULT_CATALOG } from "../src/catalog.js";

export function conv(overrides: Partial<Conversation> = {}): Conversation {
  const alias = overrides.modelAlias ?? "fable";
  const modelId = DEFAULT_CATALOG.models.find((m) => m.alias === alias)!.modelId;
  return {
    id: "c1", userId: "u1", title: "Conversación", modelAlias: alias, modelId,
    pinnedModel: null, pinReason: null, pinnedUntil: null, systemPromptVersion: "v1",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messageCount: 0, lastInputTokens: 0,
    ...overrides,
  };
}

export function collect(): { events: TurnEvent[]; emit: (e: TurnEvent) => void; text: () => string } {
  const events: TurnEvent[] = [];
  return { events, emit: (e) => events.push(e), text: () => events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("") };
}

export const history: StoredMessage[] = [];
export const refusalFallbacks = Object.fromEntries(DEFAULT_CATALOG.models.map((m) => [m.modelId, m.refusalFallbacks]));
