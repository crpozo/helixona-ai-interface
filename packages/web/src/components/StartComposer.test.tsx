import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import JSZip from "jszip";
import type { CatalogModel } from "../lib/types";
import { StartComposer } from "./StartComposer";

vi.mock("../lib/api", () => ({ ApiError: class ApiError extends Error {} }));

const models: CatalogModel[] = [{ alias: "sonnet", modelId: "anthropic.claude-sonnet-5-5", label: "Sonnet", description: "", costFactor: 1, available: true }];
const limits = { maxMb: 100, maxPerMessage: 20 };
const csv = new File(["Patient,Amount\nAna,$10.00\n"], "Checks.csv", { type: "text/csv" });
const withFiles = (files: File[]) => ({ dataTransfer: { types: ["Files"], files, dropEffect: "none" } });

/** The start screen: the composer inside a larger zone that accepts drops. */
function Screen({ onStart }: { onStart: (text: string, alias: string, files: File[]) => Promise<void> }) {
  const zone = useRef<HTMLDivElement>(null);
  return (
    <div data-testid="zone" ref={zone} className="panel-center drop-zone">
      <StartComposer models={models} defaultAlias="sonnet" attachments={limits} onStart={onStart} dropZone={zone} />
    </div>
  );
}

afterEach(cleanup);

describe("Dropping files on the start screen", () => {
  it("shows where to drop while a file is dragged over the screen, and attaches it on drop", async () => {
    const onStart = vi.fn(async () => undefined);
    render(<Screen onStart={onStart} />);
    const zone = screen.getByTestId("zone");
    fireEvent.dragEnter(zone, withFiles([]));
    expect(screen.getByText("Drop to attach")).toBeTruthy();
    fireEvent.drop(zone, withFiles([csv]));
    expect(screen.queryByText("Drop to attach")).toBeNull();
    await vi.waitFor(() => expect(screen.getByText("Checks.csv")).toBeTruthy());
    // The file travels with the first message.
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Split the checks" } });
    fireEvent.submit(screen.getByRole("button", { name: "Send" }).closest("form")!);
    await vi.waitFor(() => expect(onStart).toHaveBeenCalledWith("Split the checks", "sonnet", [csv]));
  });

  it("refuses a type it cannot read and says so, and drops onto the box itself when there is no zone", async () => {
    render(<StartComposer models={models} defaultAlias="sonnet" attachments={limits} onStart={vi.fn(async () => undefined)} />);
    const form = screen.getByRole("button", { name: "Send" }).closest("form")!;
    fireEvent.drop(form, withFiles([new File(["x"], "photo.heic", { type: "image/heic" })]));
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toContain("photo.heic: unsupported type"));
    fireEvent.drop(form, withFiles([csv]));
    await vi.waitFor(() => expect(screen.getByText("Checks.csv")).toBeTruthy());
  });

  it("opens a ZIP and attaches the files inside it", async () => {
    const zip = new JSZip();
    zip.file("EOBs/EOB 1.pdf", "%PDF-1.4");
    zip.file("Checks.csv", "Patient,Amount\nAna,$10.00\n");
    zip.file("notes.docx", "no");
    const archive = new File([await zip.generateAsync({ type: "blob" })], "EOBs.zip", { type: "application/zip" });
    render(<StartComposer models={models} defaultAlias="sonnet" attachments={limits} onStart={vi.fn(async () => undefined)} />);
    const form = screen.getByRole("button", { name: "Send" }).closest("form")!;
    fireEvent.drop(form, withFiles([archive]));
    await vi.waitFor(() => expect(screen.getByText("EOB 1.pdf")).toBeTruthy());
    expect(screen.getByText("Checks.csv")).toBeTruthy();
    expect(screen.queryByText("EOBs.zip")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("EOBs.zip: 2 files attached; 1 file of other types");
  });
});
