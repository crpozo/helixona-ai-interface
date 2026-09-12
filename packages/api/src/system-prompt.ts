import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface SystemPrompt { text: string; version: string }

/** El prompt de sistema se congela por conversación (versión = hash del contenido). */
export function loadSystemPrompt(file: string, baseDir = process.cwd()): SystemPrompt {
  const text = readFileSync(resolve(baseDir, file), "utf8").trim();
  const version = createHash("sha256").update(text).digest("hex").slice(0, 12);
  return { text, version };
}
