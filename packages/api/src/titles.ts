import { estimateUsd, type Conversation, type UsageSummary } from "@helixona/core";
import type { Deps } from "./deps.js";

/** The opaque title a conversation starts with ("Conversation Oct 27, 03:20 PM"). */
export const DEFAULT_TITLE = /^Conversation [A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2} [AP]M$/;
const TITLE_SYSTEM =
  "You name chats. Reply with a title of three to six words for a chat that starts with the message you are given: the topic, in the message's language, no quotes, no final period. Never include a person's name or initials, a date of birth, an age, a member, claim, account or phone number, an address, or anything else that could identify a patient; name the kind of document or question instead (\"Dental EOB out-of-pocket costs\"). Reply with the title only.";

/** A short topic title for a new conversation, from its first message, by the cheapest model; "" when it cannot be had. */
export async function topicTitle(deps: Deps, text: string, signal: AbortSignal, onUsage: (model: string, u: UsageSummary) => void): Promise<string> {
  const cheapest = [...deps.catalog.models].sort((a, b) => a.costFactor - b.costFactor)[0];
  if (!cheapest || !text.trim()) return "";
  try {
    const handle = deps.provider.stream({ model: cheapest.modelId, maxTokens: 40, effort: "low", system: [{ type: "text", text: TITLE_SYSTEM }], messages: [{ role: "user", content: [{ type: "text", text: text.slice(0, 2_000) }] }] }, { signal, conversationId: "title" });
    for await (const _ev of handle) {
      // the title is taken from the final message
    }
    const msg = await handle.finalMessage();
    const spent = { inputTokens: msg.usage?.input_tokens ?? 0, outputTokens: msg.usage?.output_tokens ?? 0, cacheReadTokens: msg.usage?.cache_read_input_tokens ?? 0, cacheWriteTokens: msg.usage?.cache_creation_input_tokens ?? 0 };
    onUsage(cheapest.modelId, { ...spent, estimatedUsd: estimateUsd(deps.catalog, cheapest.modelId, spent) });
    if (msg.stop_reason === "refusal") return "";
    const raw = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ");
    const title = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
    return title.replace(/^["'“”‘’#*\s]+|["'“”‘’.*\s]+$/g, "").slice(0, 60);
  } catch {
    return "";
  }
}


/** Conversations whose titles are being made right now, so a list refresh does not ask twice. */
const inFlight = new Set<string>();
const BACKFILL_PER_LIST = 8;

/**
 * Conversations that still carry the date title and already have messages get a topic title from
 * their first message, a few per listing, in the background; the next refresh shows them. Older
 * chats and imports thus catch up with the new ones without anyone renaming them by hand.
 */
export function backfillTitles(deps: Deps, items: Conversation[], userId: string): void {
  if (deps.config.AUTO_TITLE !== "true") return;
  const todo = items.filter((c) => c.messageCount > 0 && DEFAULT_TITLE.test(c.title) && !inFlight.has(c.id)).slice(0, BACKFILL_PER_LIST);
  for (const c of todo) {
    inFlight.add(c.id);
    void (async () => {
      try {
        const first = (await deps.repos.messages.list(c.id)).find((m) => m.role === "user");
        const text = first?.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim() ?? "";
        if (!text) return;
        const day = new Date().toISOString().slice(0, 10);
        const title = await topicTitle(deps, text, new AbortController().signal, (model, u) => void deps.repos.usage.add(userId, day, model, u).catch(() => undefined));
        if (title) await deps.repos.conversations.update(c.userId, c.id, { title });
      } catch {
        // next listing tries again
      } finally {
        inFlight.delete(c.id);
      }
    })();
  }
}
