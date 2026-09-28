import { createContext } from "react";
import type { DocFormat } from "./markdownExport";
import type { ResolveFile } from "./workbook";

/** A document a card hands to the viewer beside the chat. */
export interface OpenDocument {
  markdown: string;
  format: DocFormat;
  title: string;
}

/** Opens a document in the viewer beside the chat; null where there is no viewer (tests, other pages). */
export const DocumentViewerContext = createContext<((doc: OpenDocument) => void) | null>(null);

/**
 * Looks up a spreadsheet attached to the open conversation by the name the assistant used, and
 * returns its rows (so a workbook copies them exactly); null outside a conversation.
 */
export const AttachmentFilesContext = createContext<ResolveFile | null>(null);
