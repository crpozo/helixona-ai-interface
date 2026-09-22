import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Me, TrainingInfo, TrainingRecord } from "../lib/types";

const training: TrainingInfo = {
  version: "1.1",
  passingScore: 2,
  total: 2,
  questions: [
    { n: 1, text: "First question?", options: [{ letter: "A", text: "Yes" }, { letter: "B", text: "No" }] },
    { n: 2, text: "Second question?", options: [{ letter: "A", text: "Up" }, { letter: "B", text: "Down" }] },
  ],
  record: null,
};
const record: TrainingRecord = { userId: "u1", name: "Ana", email: "ana@example.test", version: "1.1", attempts: 1, lastScore: 2, lastAttemptAt: "2026-09-22T10:00:00Z", bestScore: 2, passedAt: "2026-09-22T10:00:00Z", acknowledgedAt: null };
// The fake API keeps the user's record like the real one does, so the acknowledgment section sees the passed check.
const server: { record: TrainingRecord | null } = { record: null };

vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  getTraining: vi.fn(async () => ({ ...training, record: server.record })),
  submitTrainingCheck: vi.fn(async () => {
    server.record = record;
    return { record, result: { score: 2, total: 2, passed: true, results: [{ n: 1, correct: true }, { n: 2, correct: true }] } };
  }),
  acknowledgeTraining: vi.fn(async () => {
    server.record = { ...record, acknowledgedAt: "2026-09-22T10:05:00Z" };
    return { record: server.record };
  }),
  adminTraining: vi.fn(async () => []),
}));

import { acknowledgeTraining, submitTrainingCheck } from "../lib/api";
import { DocumentationPage } from "./DocumentationPage";

const me: Me = {
  user: { id: "u1", email: "ana@example.test", name: "Ana", roles: ["staff"] },
  session: { expiresAt: "2026-09-22T12:00:00Z", idleTimeoutSeconds: 900 },
  catalog: { defaultAlias: "opus", effort: "medium", models: [] },
  limits: { maxMessageChars: 20000, contextLimitTokens: 1000000 },
};

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("Workforce training online", () => {
  it("signed-in staff answer the check, see the score, and sign the acknowledgment; the answer key stays hidden", async () => {
    window.history.replaceState(null, "", "/documentation/workforce-training");
    render(<DocumentationPage backLabel="Back" backTo="/" me={me} />);
    expect(await screen.findByText(/First question\?/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /Answer key/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Training log" })).toBeNull();
    const submit = screen.getByRole("button", { name: "Submit answers" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Yes/));
    fireEvent.click(screen.getByLabelText(/Down/));
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(submitTrainingCheck).toHaveBeenCalledWith(["A", "B"]));
    expect(await screen.findByText(/Score: 2 of 2. Passed./)).toBeTruthy();
    // The acknowledgment section becomes signable once the check is passed.
    const confirm = await screen.findByLabelText(/confirm the statements above/);
    fireEvent.click(confirm);
    fireEvent.click(screen.getByRole("button", { name: "Sign acknowledgment" }));
    await waitFor(() => expect(acknowledgeTraining).toHaveBeenCalled());
    expect(await screen.findByText(/Signed by Ana/)).toBeTruthy();
  });

  it("visitors see the paper version with a note, and no answer key", () => {
    window.history.replaceState(null, "", "/documentation/workforce-training");
    render(<DocumentationPage backLabel="Sign in" backTo="/login" />);
    expect(screen.getByText(/Staff complete this check online after signing in/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Submit answers" })).toBeNull();
    expect(screen.queryByRole("heading", { name: /Answer key/ })).toBeNull();
  });
});

describe("DocumentationPage", () => {
  it("lists the three documents with a Word download for each", () => {
    window.history.replaceState(null, "", "/documentation");
    render(<DocumentationPage backLabel="Sign in" backTo="/login" />);
    expect(screen.getByRole("heading", { level: 1, name: "Compliance documents" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "HIPAA Security Risk Analysis" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "HIPAA Policies and Procedures" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Workforce Training" })).toBeTruthy();
    const downloads = screen.getAllByRole("link", { name: "Download Word file" }).map((a) => a.getAttribute("href"));
    expect(downloads).toEqual([
      "/docs/Helixona-Assistant-Risk-Analysis.docx",
      "/docs/Helixona-Assistant-Policies-and-Procedures.docx",
      "/docs/Helixona-Assistant-Workforce-Training.docx",
    ]);
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/login");
  });

  it("opens a document from its card and renders its sections, tables and signature block", () => {
    window.history.replaceState(null, "", "/documentation");
    render(<DocumentationPage backLabel="Back to the assistant" backTo="/" />);
    fireEvent.click(screen.getAllByRole("link", { name: "Read online" })[0]!);
    expect(window.location.pathname).toBe("/documentation/risk-analysis");
    expect(screen.getByRole("heading", { level: 1, name: "HIPAA Security Risk Analysis" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "5. Risk register" })).toBeTruthy();
    expect(screen.getByText("Stolen or phished staff password")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Signature" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Contents" }).textContent).toContain("6. Remediation plan");
    expect(screen.getByRole("link", { name: "Download Word file" }).getAttribute("href")).toBe("/docs/Helixona-Assistant-Risk-Analysis.docx");
    expect(screen.getByRole("link", { name: "All documents" })).toBeTruthy();
  });

  it("renders the policies and the training from their URLs", () => {
    window.history.replaceState(null, "", "/documentation/policies-and-procedures");
    const { unmount } = render(<DocumentationPage backLabel="Sign in" backTo="/login" />);
    expect(screen.getByRole("heading", { level: 1, name: "HIPAA Policies and Procedures" })).toBeTruthy();
    unmount();
    window.history.replaceState(null, "", "/documentation/workforce-training");
    render(<DocumentationPage backLabel="Sign in" backTo="/login" />);
    expect(screen.getByRole("heading", { level: 1, name: "Workforce Training" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: /Knowledge check/ })).toBeTruthy();
  });

  it("falls back to the index for an unknown document", () => {
    window.history.replaceState(null, "", "/documentation/does-not-exist");
    render(<DocumentationPage backLabel="Sign in" backTo="/login" />);
    expect(screen.getByRole("heading", { level: 1, name: "Compliance documents" })).toBeTruthy();
  });
});
