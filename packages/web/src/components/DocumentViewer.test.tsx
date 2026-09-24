import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../lib/markdownExport", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/markdownExport")>();
  return { ...mod, downloadBlob: vi.fn(), printMarkdownDocument: vi.fn() };
});

import { downloadBlob, printMarkdownDocument } from "../lib/markdownExport";
import { DocumentViewer, paginate } from "./DocumentViewer";

const doc = { markdown: "# Intake summary\n\nLead line.\n\n## Findings\n\n- One\n\n| A | B |\n| --- | --- |\n| 1 | 2 |", format: "word" as const, title: "Intake summary" };

afterEach(cleanup);

describe("DocumentViewer", () => {
  it("shows the document as Letter pages with the letterhead, names the title and the format, and its buttons work", async () => {
    const onClose = vi.fn();
    const onToggle = vi.fn();
    render(<DocumentViewer doc={doc} expanded={false} onToggleExpand={onToggle} onClose={onClose} />);
    expect(screen.getByRole("complementary", { name: "Preview of Intake summary" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: /Intake summary · DOCX/ })).toBeTruthy();
    const page = document.querySelector(".doc-page")!;
    expect(page.querySelector(".print-doc-brand")?.textContent).toBe("HELIXONA");
    expect(page.querySelector("h1")?.textContent).toBe("Intake summary");
    expect(page.querySelector("table")).toBeTruthy();
    expect(page.querySelector(".doc-page-number")?.textContent).toBe("Page 1");
    expect(screen.getByText("Page 1 / 1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download Intake summary" }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), "Intake summary.docx"));
    fireEvent.click(screen.getByRole("button", { name: "Expand the preview" }));
    expect(onToggle).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close the preview" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("downloads in the document's own format; PDF goes to the print dialog", async () => {
    render(<DocumentViewer doc={{ ...doc, format: "pdf" }} expanded onToggleExpand={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("· PDF")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Shrink the preview" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download Intake summary" }));
    await waitFor(() => expect(printMarkdownDocument).toHaveBeenCalledWith(doc.markdown, "Intake summary"));
    cleanup();
    render(<DocumentViewer doc={{ ...doc, format: "csv" }} expanded={false} onToggleExpand={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Download Intake summary" }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), "Intake summary.csv"));
  });

  it("cuts blocks into pages by height, keeping an oversized block whole", () => {
    const blocks = [
      { html: "<p>a</p>", height: 500 },
      { html: "<p>b</p>", height: 500 },
      { html: "<p>c</p>", height: 100 },
    ];
    expect(paginate(blocks, 864)).toEqual(["<p>a</p>", "<p>b</p><p>c</p>"]);
    expect(paginate([{ html: "<p>x</p>", height: 5000 }, { html: "<p>y</p>", height: 10 }], 864)).toEqual(["<p>x</p>", "<p>y</p>"]);
    expect(paginate([], 864)).toEqual([""]);
  });
});
