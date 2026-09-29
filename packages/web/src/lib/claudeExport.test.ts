import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { batches, memoryFileProject, memoryFilesDocument, parseConversations, parseMemory, parseMemoryFile, parseProjects, readClaudeExport } from "./claudeExport";

const conversations = [
  {
    uuid: "c-1",
    name: "Lab summary",
    created_at: "2026-03-01T10:00:00Z",
    updated_at: "2026-03-01T10:30:00Z",
    project_uuid: "p-1",
    chat_messages: [
      { uuid: "m1", sender: "human", text: "Summarize these labs", created_at: "2026-03-01T10:00:00Z", attachments: [{ file_name: "labs.pdf", file_size: 100, file_type: "pdf", extracted_content: "Hemoglobin 13.1" }], files: [] },
      { uuid: "m2", sender: "assistant", text: "", content: [{ type: "text", text: "Hemoglobin is normal." }, { type: "tool_use", name: "x" }], created_at: "2026-03-01T10:01:00Z" },
      { uuid: "m3", sender: "system", text: "ignored" },
    ],
  },
  { uuid: "c-2", name: "", created_at: "not a date", chat_messages: [] },
  { name: "no id" },
];
const projects = [{ uuid: "p-1", name: "Chart prep", description: "Prep", prompt_template: "Be brief.", docs: [{ uuid: "d1", filename: "Ranges.md", content: "# Ranges" }, { uuid: "d2", filename: "empty.md", content: "  " }] }, { uuid: "p-2", name: "" }];

describe("Reading a Claude.ai export", () => {
  it("keeps chats with their messages, dates, attachment text and project; drops what it cannot use", () => {
    const out = parseConversations(conversations);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      sourceId: "c-1",
      name: "Lab summary",
      createdAt: "2026-03-01T10:00:00.000Z",
      updatedAt: "2026-03-01T10:30:00.000Z",
      projectSourceId: "p-1",
      messages: [
        { role: "user", text: "Summarize these labs", createdAt: "2026-03-01T10:00:00.000Z", attachments: [{ name: "labs.pdf", text: "Hemoglobin 13.1" }] },
        { role: "assistant", text: "Hemoglobin is normal.", createdAt: "2026-03-01T10:01:00.000Z", attachments: [] },
      ],
    });
    expect(out[1]).toMatchObject({ sourceId: "c-2", createdAt: undefined, projectSourceId: null, messages: [] });
    expect(parseProjects(projects)).toEqual([{ sourceId: "p-1", name: "Chart prep", description: "Prep", instructions: "Be brief.", docs: [{ name: "Ranges.md", text: "# Ranges" }] }]);
    expect(parseMemory('{"memories":[{"uuid":"1","content":"Works at Helixona"},{"content":"Prefers tables"}]}')).toBe("Works at Helixona\nPrefers tables");
    expect(parseMemory("Plain memory text")).toBe("Plain memory text");
    // The newer export's memory file: a summary, one per project, and the memory directory.
    const structured = parseMemoryFile(JSON.stringify({ conversations_memory: "Works at Helixona.", project_memories: { "p-1": "Chart prep notes", "p-2": "  " }, memory_files: [{ path: "/areas/billing.md", content: "Billing notes", updated_at: "x" }, { path: "/projects/p-1/plan.md", content: "Plan" }, { path: "/topics/empty.md", content: " " }], account_uuid: "a" }));
    expect(structured).toEqual({ memory: "Works at Helixona.", projectMemories: { "p-1": "Chart prep notes" }, memoryFiles: [{ path: "/areas/billing.md", text: "Billing notes" }, { path: "/projects/p-1/plan.md", text: "Plan" }] });
    expect(parseMemoryFile("Plain").memory).toBe("Plain");
    expect(memoryFileProject("/projects/p-1/plan.md")).toBe("p-1");
    expect(memoryFileProject("/areas/billing.md")).toBeNull();
    expect(memoryFilesDocument(structured.memoryFiles)).toBe("## /areas/billing.md\n\nBilling notes\n\n## /projects/p-1/plan.md\n\nPlan");
  });

  it("reads the zip Claude sends, or its files, and batches chats by size", async () => {
    const zip = new JSZip();
    zip.file("conversations.json", JSON.stringify(conversations));
    zip.file("projects.json", JSON.stringify(projects));
    zip.file("users.json", "[]");
    zip.file("memory.txt", "Likes short answers");
    const file = new File([await zip.generateAsync({ type: "blob" })], "data-2026-03-01.zip", { type: "application/zip" });
    const out = await readClaudeExport([file]);
    expect(out.files).toEqual(["data-2026-03-01.zip › conversations.json", "data-2026-03-01.zip › projects.json", "data-2026-03-01.zip › memory.txt"]);
    expect(out.ignored).toEqual(["data-2026-03-01.zip › users.json"]);
    expect(out.conversations).toHaveLength(2);
    expect(out.projects).toHaveLength(1);
    expect(out.memory).toBe("Likes short answers");
    const json = new File([JSON.stringify(conversations)], "conversations.json", { type: "application/json" });
    expect((await readClaudeExport([json])).conversations).toHaveLength(2);
    await expect(readClaudeExport([new File(["hi"], "notes.txt")])).rejects.toThrow(/No conversations/);
    await expect(readClaudeExport([new File([JSON.stringify({ data_files: [{ export_url: "https://claude.ai/export/x" }] })], "manifest-abc.json")])).rejects.toThrow(/manifest/);

    // The newer export: one zip per part, files added in two picks, nothing repeated.
    const convZip = new JSZip();
    convZip.file("conversations/c-1.json", JSON.stringify(conversations[0]));
    convZip.file("conversations/c-2.json", JSON.stringify({ conversations: [conversations[1], conversations[0]] }));
    const memZip = new JSZip();
    memZip.file("memories/memories-000.json", JSON.stringify([{ uuid: "m1", content: "Works at Helixona" }, { uuid: "m2", content: "Prefers tables" }]));
    const framesZip = new JSZip();
    framesZip.file("frames/frame-1.json", "{}");
    const first = await readClaudeExport([new File([await convZip.generateAsync({ type: "blob" })], "conversations-000.zip"), new File([await framesZip.generateAsync({ type: "blob" })], "frames-000.zip")]);
    expect(first.conversations.map((c) => c.sourceId)).toEqual(["c-1", "c-2"]);
    expect(first.ignored).toEqual(["frames-000.zip › frame-1.json"]);
    const second = await readClaudeExport([new File([await memZip.generateAsync({ type: "blob" })], "memories-000.zip"), new File([await convZip.generateAsync({ type: "blob" })], "conversations-000.zip")], { previous: first });
    expect(second.conversations).toHaveLength(2);
    expect(second.memory).toBe("Works at Helixona\nPrefers tables");
    expect(second.files).toHaveLength(5);

    const big = { messages: [{ text: "x".repeat(2_000_000), attachments: [] }] };
    const small = { messages: [{ text: "hi", attachments: [{ text: "y".repeat(10) }] }] };
    expect(batches([big, big, small, small], 3_000_000, 100).map((b) => b.length)).toEqual([1, 3]);
    expect(batches([small, small, small], 3_000_000, 2).map((b) => b.length)).toEqual([2, 1]);
  });
});
