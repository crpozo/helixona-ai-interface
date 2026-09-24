import { createContext } from "react";
import type { DocFormat } from "./markdownExport";

/** A document a card hands to the viewer beside the chat. */
export interface OpenDocument {
  markdown: string;
  format: DocFormat;
  title: string;
}

/** Opens a document in the viewer beside the chat; null where there is no viewer (tests, other pages). */
export const DocumentViewerContext = createContext<((doc: OpenDocument) => void) | null>(null);
