import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CatalogModel, Conversation, Project } from "../lib/types";

vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  updateProject: vi.fn(async (_id: string, patch: Partial<Project>) => ({ ...project, ...patch })),
  listUsers: vi.fn(async () => []),
  addProjectMember: vi.fn(),
  removeProjectMember: vi.fn(),
  createProjectKnowledge: vi.fn(),
  deleteProjectKnowledge: vi.fn(),
  registerProjectKnowledge: vi.fn(),
  uploadFile: vi.fn(),
}));

import { updateProject } from "../lib/api";
import { ProjectPage, relativeTime } from "./ProjectPage";

const models: CatalogModel[] = [
  { alias: "sonnet", modelId: "anthropic.claude-sonnet-5", label: "Sonnet", description: "", costFactor: 1, available: true },
  { alias: "opus", modelId: "anthropic.claude-opus-5", label: "Opus", description: "", costFactor: 2.5, available: true },
];
const project: Project = {
  id: "p1",
  ownerId: "u1",
  ownerName: "Ana",
  name: "EOB review",
  description: "Explanation-of-benefits checks",
  instructions: "",
  visibility: "private",
  members: [],
  knowledge: [],
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  canEdit: true,
  canManage: true,
};
const conv = (id: string, title: string, updatedAt: string): Conversation => ({ id, title, modelAlias: "sonnet", modelId: "anthropic.claude-sonnet-5", pinnedModel: null, pinReason: null, createdAt: updatedAt, updatedAt, messageCount: 2, projectId: "p1" });

function renderPage(over: Partial<React.ComponentProps<typeof ProjectPage>> = {}) {
  const props = {
    project,
    conversations: [conv("c1", "Older chat", "2026-09-10T10:00:00Z"), conv("c2", "Newest chat", "2026-09-15T10:00:00Z")],
    models,
    defaultAlias: "opus",
    maxMb: 20,
    uploadsEnabled: true,
    meId: "u1",
    onBack: vi.fn(),
    onOpenConversation: vi.fn(),
    onStartConversation: vi.fn(async () => {}),
    onUpdated: vi.fn(),
    onDelete: vi.fn(),
    ...over,
  };
  render(<ProjectPage {...props} />);
  return props;
}

afterEach(cleanup);

describe("ProjectPage", () => {
  it("shows the breadcrumb, the composer, the recents and the side cards", () => {
    const p = renderPage();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).toContain("Projects");
    expect(screen.getByRole("heading", { level: 1, name: "EOB review" })).toBeTruthy();
    expect(screen.getByText("Explanation-of-benefits checks")).toBeTruthy();
    expect(screen.getByPlaceholderText("How can I help you today?")).toBeTruthy();
    expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("opus");
    const rows = screen.getAllByRole("button", { name: /chat/ }).map((b) => b.textContent);
    expect(rows[0]).toContain("Newest chat");
    expect(rows[1]).toContain("Older chat");
    expect(screen.getByRole("heading", { name: "Instructions" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Knowledge" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    expect(p.onBack).toHaveBeenCalled();
  });

  it("starts a conversation from the composer with the chosen model", async () => {
    const p = renderPage();
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "sonnet" } });
    fireEvent.change(screen.getByPlaceholderText("How can I help you today?"), { target: { value: "  Summarize this EOB  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(p.onStartConversation).toHaveBeenCalledWith("Summarize this EOB", "sonnet", []));
    await waitFor(() => expect((screen.getByPlaceholderText("How can I help you today?") as HTMLTextAreaElement).value).toBe(""));
  });

  it("edits the instructions in place and saves only that field", async () => {
    const p = renderPage();
    expect(screen.getByText(/Add instructions to tailor/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const field = screen.getByLabelText("Instructions for the assistant");
    fireEvent.change(field, { target: { value: "Always answer in English." } });
    fireEvent.click(within(field.closest("form")!).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateProject).toHaveBeenCalledWith("p1", { instructions: "Always answer in English." }));
    await waitFor(() => expect(p.onUpdated).toHaveBeenCalledWith(expect.objectContaining({ instructions: "Always answer in English." })));
  });

  it("hides editing for read-only projects", () => {
    renderPage({ project: { ...project, canEdit: false, visibility: "clinic" } });
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add files" })).toBeNull();
    expect(screen.getByText(/Only the project owner or an administrator/)).toBeTruthy();
    expect(screen.getByText("Shared with the clinic")).toBeTruthy();
  });

  it("formats relative times", () => {
    const now = Date.parse("2026-09-16T12:00:00Z");
    expect(relativeTime("2026-09-16T11:59:40Z", now)).toBe("Just now");
    expect(relativeTime("2026-09-16T11:48:00Z", now)).toBe("12 min ago");
    expect(relativeTime("2026-09-16T09:00:00Z", now)).toBe("3 hours ago");
    expect(relativeTime("2026-09-11T12:00:00Z", now)).toBe("5 days ago");
    expect(relativeTime("2026-08-31T12:00:00Z", now)).toBe("Aug 31");
  });
});
