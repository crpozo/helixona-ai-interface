import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../lib/markdownExport", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/markdownExport")>();
  return { ...mod, downloadBlob: vi.fn(), printMarkdownDocument: vi.fn(), copyFormatted: vi.fn(async () => true) };
});

import { copyFormatted, downloadBlob, printMarkdownDocument } from "../lib/markdownExport";
import { Markdown } from "./Markdown";

const reply = "Here it is.\n\n```document\n# Intake summary\n\nLead line.\n\n## Findings\n\n- One\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n```\n\nReview before sending.";

afterEach(cleanup);

describe("DocumentCard", () => {
  it("shows a document fence as a card: title, kind, Copy, the download and the other formats, a preview", async () => {
    render(<Markdown text={reply} documentReady fallbackTitle="Conversation Sep 24" />);
    expect(screen.getByRole("group", { name: "Document: Intake summary" })).toBeTruthy();
    expect(screen.getByText("Document · DOCX")).toBeTruthy();
    // The remarks around the block stay as text.
    expect(screen.getByText("Here it is.")).toBeTruthy();
    expect(screen.getByText("Review before sending.")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Download Intake summary as Word" }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), "Intake summary.docx"));
    fireEvent.click(screen.getByRole("button", { name: "Download Intake summary as CSV" }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), "Intake summary.csv"));
    fireEvent.click(screen.getByRole("button", { name: "Download Intake summary as Text" }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), "Intake summary.txt"));
    fireEvent.click(screen.getByRole("button", { name: "Download Intake summary as PDF" }));
    expect(printMarkdownDocument).toHaveBeenCalledWith(expect.stringContaining("# Intake summary"), "Intake summary");
    fireEvent.click(screen.getByRole("button", { name: "Copy Intake summary" }));
    await waitFor(() => expect(copyFormatted).toHaveBeenCalled());
    expect((copyFormatted as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0]).toContain("<h1>Intake summary</h1>");
    fireEvent.click(screen.getByRole("button", { name: "Show preview" }));
    expect(screen.getByRole("heading", { level: 1, name: "Intake summary" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide preview" })).toBeTruthy();
  });

  it("while the message is still streaming the card says so and waits", () => {
    render(<Markdown text={"```document\n# Draft\n\nText"} documentReady={false} />);
    expect(screen.getByText("Writing the document…")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Download Draft as Word" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Copy Draft" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("the requested format leads; a spreadsheet needs a table; a document without a title takes the conversation's", () => {
    render(<Markdown text={"```document-pdf\n# Letter\n\nDear patient\n```"} documentReady />);
    expect(screen.getByText("Document · PDF")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download Letter as PDF" }).textContent).toBe("Save as PDF");
    expect(screen.queryByRole("button", { name: "Download Letter as CSV" })).toBeNull();
    cleanup();
    render(<Markdown text={"```document-csv\nNo table here\n```"} documentReady fallbackTitle="Conversation Sep 24" />);
    expect(screen.getByText("Document · DOCX")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download Conversation Sep 24 as Word" })).toBeTruthy();
    cleanup();
    // Ordinary code stays code.
    render(<Markdown text={"```json\n{\"a\":1}\n```"} documentReady />);
    expect(screen.queryByRole("group")).toBeNull();
    expect(document.querySelector("pre code")?.textContent).toContain('{"a":1}');
  });
});
