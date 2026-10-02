import JSZip from "jszip";
import { ATTACH_TYPES_TEXT, attachmentType } from "./files";

/**
 * A ZIP attached to a message is opened here, in the browser, and its PDF, Excel, CSV and text
 * files are attached one by one, as if they had been picked themselves. The ZIP itself never
 * leaves the computer; nested ZIPs, folders' bookkeeping files and other types are left out and
 * named in a note. Caps keep a hostile archive from filling the memory.
 */
export const ZIP_LIMITS = { maxEntries: 200, maxTotalBytes: 600 * 1048576 } as const;

export function isZip(file: File): boolean {
  return /\.zip$/i.test(file.name) || file.type === "application/zip" || file.type === "application/x-zip-compressed";
}

export interface ExpandedFiles {
  files: File[];
  /** What was left out, in words for the person. */
  notes: string[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export async function expandZips(picked: File[]): Promise<ExpandedFiles> {
  const files: File[] = [];
  const notes: string[] = [];
  for (const file of picked) {
    if (!isZip(file)) {
      files.push(file);
      continue;
    }
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(await file.arrayBuffer());
    } catch {
      notes.push(`${file.name} could not be opened as a ZIP.`);
      continue;
    }
    const entries = Object.values(zip.files)
      .filter((e) => !e.dir)
      .map((e) => ({ entry: e, base: e.name.split("/").pop() ?? e.name }))
      .filter(({ entry, base }) => !entry.name.startsWith("__MACOSX/") && !base.startsWith("."))
      .sort((a, b) => a.entry.name.localeCompare(b.entry.name, "en", { numeric: true }));
    let added = 0;
    let other = 0;
    let nested = 0;
    let total = 0;
    let stopped: string | null = null;
    for (const { entry, base } of entries) {
      if (/\.zip$/i.test(base)) {
        nested++;
        continue;
      }
      const type = attachmentType(new File([], base));
      if (!type) {
        other++;
        continue;
      }
      if (added >= ZIP_LIMITS.maxEntries) {
        stopped = `only the first ${ZIP_LIMITS.maxEntries} files of ${file.name} were opened`;
        break;
      }
      const bytes = await entry.async("blob");
      total += bytes.size;
      if (total > ZIP_LIMITS.maxTotalBytes) {
        stopped = `${file.name} holds more than ${Math.round(ZIP_LIMITS.maxTotalBytes / 1048576)} MB of files; the rest was not opened`;
        break;
      }
      files.push(new File([bytes], base, { type, lastModified: entry.date?.getTime() ?? Date.now() }));
      added++;
    }
    const left: string[] = [];
    if (other > 0) left.push(`${plural(other, "file", "files")} of other types (use ${ATTACH_TYPES_TEXT})`);
    if (nested > 0) left.push(`${plural(nested, "ZIP inside it", "ZIPs inside it")}`);
    if (added === 0 && left.length === 0 && !stopped) notes.push(`${file.name} is empty.`);
    else if (left.length > 0 || stopped) notes.push(`${file.name}: ${plural(added, "file", "files")} attached; ${[...left.map((l) => `${l} left out`), ...(stopped ? [stopped] : [])].join("; ")}.`);
  }
  return { files, notes };
}
