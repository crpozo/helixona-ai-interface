import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { chatReducer, initialChatState, type ChatState } from "../lib/chatReducer";
import { readsPageByPage } from "../lib/files";
import type { ChatSseEvent, SseFiles } from "../lib/types";
import { MessageBubble } from "./MessageBubble";

const models = [{ alias: "opus", modelId: "anthropic.claude-opus-5-5", label: "Opus 5.5", description: "", costFactor: 2, available: true }];
const reading: SseFiles = {
  phase: "reading",
  files: [
    { id: "a", name: "Records 2019-2024.pdf", pages: 184, pagesDone: 64, state: "reading" },
    { id: "b", name: "Labs.pdf", pages: 40, pagesDone: 40, state: "done" },
    { id: "c", name: "UCI.pdf", pages: 120, pagesDone: 0, state: "queued" },
  ],
};

function sending(): ChatState {
  let s = chatReducer(initialChatState, { type: "load", conversationId: "c1", messages: [] });
  s = chatReducer(s, { type: "send", text: "Summarize the labs", userId: "lu", assistantId: "la" });
  return s;
}
const sse = (s: ChatState, event: ChatSseEvent) => chatReducer(s, { type: "sse", event });
const last = (s: ChatState) => s.messages[s.messages.length - 1]!;

afterEach(cleanup);

describe("Large files read before the answer", () => {
  it("keeps the latest snapshot on the pending answer; an empty list clears it; the answer keeps it after it starts", () => {
    let s = sending();
    s = sse(s, { type: "files", data: { phase: "checking", files: [{ id: "a", name: "Records.pdf", pages: null, pagesDone: 0, state: "checking" }] } });
    expect(last(s).files?.phase).toBe("checking");
    s = sse(s, { type: "files", data: reading });
    expect(last(s).files).toEqual(reading);
    s = sse(s, { type: "message_start", data: { userMessageId: "u1", assistantMessageId: "a1", model: "anthropic.claude-opus-5-5" } });
    s = sse(s, { type: "text_delta", data: { text: "Summary" } });
    expect(last(s).files).toEqual(reading);
    let t = sending();
    t = sse(t, { type: "files", data: reading });
    t = sse(t, { type: "files", data: { phase: "read", files: [] } });
    expect(last(t).files).toBeNull();
  });

  it("shows a line per file while reading, instead of Thinking…", () => {
    let s = sending();
    s = sse(s, { type: "files", data: reading });
    render(<MessageBubble message={last(s)} models={models} />);
    expect(screen.getByText(/Reading 3 large files page by page \(344 pages\)/)).toBeTruthy();
    expect(screen.getByText("64 of 184 pages")).toBeTruthy();
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.getByText("Waiting")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Records 2019-2024.pdf: 64 of 184 pages read" }).getAttribute("aria-valuenow")).toBe("64");
    expect(screen.queryByText(/Thinking/)).toBeNull();
  });

  it("sums up above the answer, names pages that could not be read, and says where a stopped reading got to", () => {
    let s = sending();
    s = sse(s, {
      type: "files",
      data: { phase: "read", files: [{ id: "a", name: "UCI.pdf", pages: 120, pagesDone: 120, state: "failed", note: "Pages 41–48 could not be read." }, { id: "b", name: "Labs.pdf", pages: 40, pagesDone: 40, state: "done" }] },
    });
    render(<MessageBubble message={last(s)} models={models} />);
    expect(screen.getByText("Read 2 large files page by page · 160 pages")).toBeTruthy();
    expect(screen.getByText("UCI.pdf: Pages 41–48 could not be read.")).toBeTruthy();
    // The model is at work now: Thinking… shows again.
    expect(screen.getByText(/Thinking/)).toBeTruthy();
    cleanup();

    let t = sending();
    t = sse(t, { type: "files", data: reading });
    t = chatReducer(t, { type: "stopped" });
    render(<MessageBubble message={last(t)} models={models} />);
    expect(screen.getByText(/Reading stopped at 104 pages of 344\. The pages already read are kept/)).toBeTruthy();
  });

  it("a message with many files shows the first four and a button for the rest", () => {
    let s = chatReducer(initialChatState, { type: "load", conversationId: "c1", messages: [] });
    const attachments = Array.from({ length: 11 }, (_, i) => ({ id: `f${i}`, name: `Lab panel ${i + 1}.pdf`, contentType: "application/pdf", size: 2048, pages: 2 }));
    s = chatReducer(s, { type: "send", text: "Chart prep", userId: "lu", assistantId: "la", attachments });
    const user = s.messages.find((m) => m.role === "user")!;
    render(<MessageBubble message={user} models={models} />);
    expect(screen.getByRole("list", { name: "Attached files (11)" }).querySelectorAll(".attach-chip")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "+7 more files" }));
    expect(document.querySelectorAll(".attach-chip")).toHaveLength(11);
    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(document.querySelectorAll(".attach-chip")).toHaveLength(4);
  });

  it("tells the composer when files will be read page by page", () => {
    const pdf = (mb: number) => ({ contentType: "application/pdf", size: mb * 1048576 });
    expect(readsPageByPage([pdf(2), pdf(3)])).toBe(false);
    expect(readsPageByPage([pdf(16)])).toBe(true);
    expect(readsPageByPage([pdf(10), pdf(10)])).toBe(true);
    expect(readsPageByPage([{ contentType: "text/plain", size: 30 * 1048576 }])).toBe(false);
  });
});
