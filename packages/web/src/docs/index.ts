/**
 * The clinic's HIPAA documents, rendered by the Documentation page. The JSON trees and the Word
 * files under `public/docs/` are generated together by `tools/hipaa-docs/build.js`; edit the
 * content there, never these files.
 */
import policies from "./policies-and-procedures.json";
import riskAnalysis from "./risk-analysis.json";
import training from "./workforce-training.json";

export type Run = string | { b: string } | { i: string };
export type Cell = string | string[];

export type DocNode =
  | { type: "title"; title: string; subtitle: string; meta: [string, string][] }
  | { type: "h"; level: 1 | 2 | 3; text: string }
  | { type: "p"; runs: Run[]; italics?: boolean; bold?: boolean; size?: number; align?: string }
  | { type: "note"; text: string }
  | { type: "list"; ordered: boolean; items: Run[][] }
  | { type: "table"; headers: string[]; rows: Cell[][]; widths: number[] }
  | { type: "kv"; rows: [string, string][]; widths: [number, number] }
  | { type: "signatures"; roles: string[] }
  | { type: "spacer" }
  | { type: "pageBreak" };

export interface HipaaDocument {
  slug: string;
  title: string;
  subtitle: string;
  summary: string;
  /** File name of the Word version under `/docs/`. */
  docx: string;
  children: DocNode[];
}

export const documents: readonly HipaaDocument[] = [riskAnalysis, policies, training] as unknown as HipaaDocument[];

export function findDocument(slug: string): HipaaDocument | undefined {
  return documents.find((d) => d.slug === slug);
}

export function docxUrl(doc: HipaaDocument): string {
  return `${import.meta.env.BASE_URL}docs/${doc.docx}`;
}
