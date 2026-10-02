import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { expandZips, isZip } from "./zipFiles";

async function zipFile(name: string, entries: Record<string, string>): Promise<File> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(entries)) zip.file(path, content);
  return new File([await zip.generateAsync({ type: "blob" })], name, { type: "application/zip" });
}

describe("A ZIP attached to a message", () => {
  it("is opened in the browser: its supported files are attached one by one, the rest is named", async () => {
    const zip = await zipFile("EOBs March.zip", {
      "March/EOB 2.pdf": "%PDF-1.4 second",
      "March/EOB 10.pdf": "%PDF-1.4 tenth",
      "Checks.csv": "Patient,Amount\nAna,$10.00\n",
      "__MACOSX/._EOB 2.pdf": "junk",
      ".DS_Store": "junk",
      "notes.docx": "a word file",
      "photo.heic": "a photo",
      "more.zip": "nested",
    });
    const plain = new File(["x"], "Letter.pdf", { type: "application/pdf" });
    const { files, notes } = await expandZips([plain, zip]);
    expect(files.map((f) => [f.name, f.type])).toEqual([
      ["Letter.pdf", "application/pdf"],
      ["Checks.csv", "text/csv"],
      ["EOB 2.pdf", "application/pdf"],
      ["EOB 10.pdf", "application/pdf"],
    ]);
    expect(await files[3]!.text()).toBe("%PDF-1.4 tenth");
    expect(notes).toEqual(["EOBs March.zip: 3 files attached; 2 files of other types (use PDF, Excel, CSV, TXT or MD, or a ZIP of them) left out; 1 ZIP inside it left out."]);
    expect(isZip(new File([], "x.ZIP"))).toBe(true);
    expect(isZip(new File([], "x.pdf", { type: "application/pdf" }))).toBe(false);
  });

  it("says when a file is not a ZIP or holds nothing usable", async () => {
    const broken = new File(["not a zip"], "broken.zip", { type: "application/zip" });
    const empty = await zipFile("empty.zip", {});
    const { files, notes } = await expandZips([broken, empty]);
    expect(files).toEqual([]);
    expect(notes).toEqual(["broken.zip could not be opened as a ZIP.", "empty.zip is empty."]);
  });
});
