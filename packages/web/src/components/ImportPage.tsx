import { useRef, useState } from "react";
import type { Me } from "../lib/types";
import { ApiError, importClaudeConversations, importClaudeDestination, importClaudeProjects } from "../lib/api";
import { batches, readClaudeExport, type ClaudeExport } from "../lib/claudeExport";
import { useFileDrop } from "../lib/useFileDrop";

interface Props {
  me: Me;
  onBack: () => void;
  /** The import created conversations and projects: the lists must be reloaded. */
  onImported: () => void;
}

interface Progress {
  done: number;
  total: number;
  step: string;
}
interface Outcome {
  conversations: number;
  skipped: number;
  empty: number;
  projects: number;
  projectsSkipped: number;
  docs: number;
  memory: boolean;
}

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Something went wrong.");
const n = (v: number) => v.toLocaleString("en-US");

/**
 * Import from Claude: the person downloads their data from Claude.ai, drops the zip here, sees what
 * is in it, and brings it over. Chats keep their messages and dates; Claude projects become
 * projects with their documents; the memory becomes the instructions of the project the chats
 * land in. The export is read in the browser and sent to the clinic's own server in batches.
 */
export function ImportPage({ me, onBack, onImported }: Props) {
  const [reading, setReading] = useState(false);
  const [data, setData] = useState<ClaudeExport | null>(null);
  const [memory, setMemory] = useState("");
  const [includeProjects, setIncludeProjects] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const zoneRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setError(null);
    setOutcome(null);
    setReading(true);
    try {
      const parsed = await readClaudeExport(Array.from(list));
      setData(parsed);
      setMemory(parsed.memory);
    } catch (e) {
      setData(null);
      setError(errMsg(e));
    } finally {
      setReading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };
  const dragging = useFileDrop(zoneRef, (files) => void load(files), !progress);

  const run = async () => {
    if (!data) return;
    setError(null);
    const projects = includeProjects ? data.projects : [];
    const chats = data.conversations.filter((c) => c.messages.length > 0);
    const total = projects.length + chats.length + 1;
    let done = 0;
    const result: Outcome = { conversations: 0, skipped: 0, empty: data.conversations.length - chats.length, projects: 0, projectsSkipped: 0, docs: 0, memory: memory.trim().length > 0 };
    setProgress({ done, total, step: "Preparing the destination project…" });
    try {
      const { projectId: destination } = await importClaudeDestination(memory.trim());
      done++;
      const projectIds = new Map<string, string>();
      if (projects.length > 0) {
        setProgress({ done, total, step: `Importing ${n(projects.length)} projects…` });
        const r = await importClaudeProjects(projects);
        for (const p of r.projects) {
          projectIds.set(p.sourceId, p.id);
          if (p.skipped) result.projectsSkipped++;
          else {
            result.projects++;
            result.docs += p.docs;
          }
        }
        done += projects.length;
      }
      for (const batch of batches(chats)) {
        setProgress({ done, total, step: `Importing chats… ${n(done)} of ${n(total)}` });
        const r = await importClaudeConversations(
          batch.map((c) => ({
            sourceId: c.sourceId,
            name: c.name,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
            projectId: (c.projectSourceId && projectIds.get(c.projectSourceId)) || destination,
            messages: c.messages,
          })),
        );
        for (const c of r.conversations) {
          if (c.status === "imported") result.conversations++;
          else if (c.status === "skipped") result.skipped++;
          else result.empty++;
        }
        done += batch.length;
        setProgress({ done, total, step: `Importing chats… ${n(done)} of ${n(total)}` });
      }
      setOutcome(result);
      setData(null);
      onImported();
    } catch (e) {
      setError(`The import stopped: ${errMsg(e)} What was already imported is kept; run it again to continue (imported chats are not duplicated).`);
    } finally {
      setProgress(null);
    }
  };

  const dates = data ? data.conversations.map((c) => c.createdAt ?? "").filter(Boolean).sort() : [];
  const fmt = (s: string) => new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const messages = data ? data.conversations.reduce((k, c) => k + c.messages.length, 0) : 0;

  return (
    <main className="admin import-page">
      <header className="admin-head">
        <h1>Import from Claude</h1>
        <div className="row gap">
          <span className="muted small">{me.user.name}</span>
          <a
            href="/"
            className="btn"
            onClick={(e) => {
              e.preventDefault();
              onBack();
            }}
          >
            Back to the assistant
          </a>
        </div>
      </header>

      <section className="card">
        <h2>1. Download your data from Claude</h2>
        <ol className="import-steps">
          <li>
            In Claude.ai open <strong>Settings → Privacy → Export data</strong> and confirm. Claude emails a download link within a few minutes (up to a day for large accounts).
          </li>
          <li>
            Download the <strong>.zip</strong> from that email. It holds <code>conversations.json</code>, <code>projects.json</code> and <code>users.json</code>.
          </li>
          <li>
            Memory: if the zip has no memory file, open <strong>Settings → Capabilities → Memory</strong> in Claude.ai, copy the memory text, and paste it below.
          </li>
        </ol>
        <p className="muted small">Attachments are not in the export; what Claude extracted from them (the text) is, and comes over with the message.</p>
      </section>

      <section className="card">
        <h2>2. Pick the export</h2>
        <div ref={zoneRef} className={`import-drop${dragging ? " dragging" : ""}`}>
          <input ref={fileRef} type="file" accept=".zip,.json,.txt,.md,application/zip,application/json" multiple hidden onChange={(e) => void load(e.target.files)} />
          <p>
            Drop the zip here, or{" "}
            <button type="button" className="link" onClick={() => fileRef.current?.click()} disabled={reading || !!progress}>
              choose the file
            </button>
            .
          </p>
          <p className="muted small">The zip is read on this computer. Nothing is sent until you press Import.</p>
          {reading && (
            <p className="muted" role="status">
              Reading the export…
            </p>
          )}
        </div>
        {data && (
          <div className="import-summary" role="status">
            <p>
              Found in {data.files.join(", ")}:
            </p>
            <ul>
              <li>
                <strong>{n(data.conversations.length)}</strong> chats with <strong>{n(messages)}</strong> messages
                {dates.length > 0 ? `, from ${fmt(dates[0]!)} to ${fmt(dates[dates.length - 1]!)}` : ""}
              </li>
              <li>
                <strong>{n(data.projects.length)}</strong> projects with {n(data.projects.reduce((k, p) => k + p.docs.length, 0))} documents
              </li>
              <li>Memory: {data.memory ? "found in the export" : "not in the export (paste it below if you want it)"}</li>
            </ul>
            {data.projects.length > 0 && (
              <label className="check">
                <input type="checkbox" checked={includeProjects} onChange={(e) => setIncludeProjects(e.target.checked)} /> Import the projects too (instructions and documents)
              </label>
            )}
          </div>
        )}
      </section>

      <section className="card">
        <h2>3. Memory</h2>
        <p className="muted small">
          Becomes the instructions of a project named <strong>Imported from Claude</strong>, where the chats that belonged to no project land. Every conversation in that project starts with this context; you can edit it there later.
        </p>
        <label htmlFor="import-memory" className="visually-hidden">
          Memory text
        </label>
        <textarea id="import-memory" rows={6} value={memory} onChange={(e) => setMemory(e.target.value)} placeholder="Paste what Claude remembers about you and your work (optional)" disabled={!!progress} maxLength={20000} />
      </section>

      <section className="card">
        <h2>4. Import</h2>
        <p className="muted small">
          Chats keep their messages and dates and can be continued here. Like every conversation in the assistant, imported chats are kept for the clinic's retention period and then deleted; projects and their documents stay until you delete them.
        </p>
        {progress && (
          <div className="import-progress" role="status" aria-live="polite">
            <p>{progress.step}</p>
            <span className="file-bar" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done} aria-label="Import progress">
              <span style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }} />
            </span>
          </div>
        )}
        {error && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}
        {outcome && (
          <div className="notice import-done" role="status">
            <p>
              <strong>Done.</strong> {n(outcome.conversations)} chats imported
              {outcome.skipped > 0 ? `, ${n(outcome.skipped)} already here (skipped)` : ""}
              {outcome.empty > 0 ? `, ${n(outcome.empty)} empty` : ""}
              {outcome.projects > 0 || outcome.projectsSkipped > 0 ? `; ${n(outcome.projects)} projects with ${n(outcome.docs)} documents${outcome.projectsSkipped > 0 ? ` (${n(outcome.projectsSkipped)} already here)` : ""}` : ""}
              {outcome.memory ? "; memory saved as the project's instructions" : ""}.
            </p>
            <p className="muted small">The chats are in the sidebar; the ones from Claude projects are inside those projects.</p>
          </div>
        )}
        <div className="row gap">
          <button type="button" className="btn btn-primary" disabled={!data || !!progress || (data.conversations.length === 0 && (!includeProjects || data.projects.length === 0) && !memory.trim())} onClick={() => void run()}>
            {progress ? "Importing…" : "Import"}
          </button>
          {data && !progress && (
            <button type="button" className="btn" onClick={() => setData(null)}>
              Clear
            </button>
          )}
        </div>
      </section>
    </main>
  );
}
