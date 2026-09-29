import { useRef, useState } from "react";
import type { Me } from "../lib/types";
import { ApiError, importClaudeConversations, importClaudeDestination, importClaudeProjects } from "../lib/api";
import { batches, memoryFileProject, memoryFilesDocument, projectsDocument, readClaudeExport, type ClaudeExport, type ExportProject } from "../lib/claudeExport";
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
  /** Documents of the Claude projects that did not fit in the team backup's file. */
  docsLeft: string[];
  memory: boolean;
  memoryFiles: number;
  team: boolean;
  destination: string;
  members: number;
  archive: boolean;
}

export const TEAM_PROJECT = "Backup Claude";
export const PRIVATE_PROJECT = "Imported from Claude";

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Something went wrong.");
const n = (v: number) => v.toLocaleString("en-US");

/**
 * Import from Claude: the person downloads their data from Claude.ai, drops the zips here, sees what
 * is in them, and brings it over. Chats keep their messages and dates; the memory becomes the
 * instructions of the project the chats land in. Two destinations: a private project of their own
 * ("Imported from Claude", with the Claude projects as separate private projects), or a project
 * shared with the whole team ("Backup Claude", where everything, the Claude projects included, lands
 * in one place everyone can ask about). The export is read in the browser and sent to the clinic's
 * own server in batches.
 */
export function ImportPage({ me, onBack, onImported }: Props) {
  const [reading, setReading] = useState(false);
  const [data, setData] = useState<ClaudeExport | null>(null);
  const [memory, setMemory] = useState("");
  const [includeProjects, setIncludeProjects] = useState(true);
  const [team, setTeam] = useState(false);
  // Unset: follows the destination (a team backup is kept; a private import follows the retention).
  const [keep, setKeep] = useState<boolean | null>(null);
  const archive = keep ?? team;
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
      const parsed = await readClaudeExport(Array.from(list), { previous: data });
      setData(parsed);
      if (parsed.memory && !memory.trim()) setMemory(parsed.memory);
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
    const withProjects = includeProjects && data.projects.length > 0;
    // Private: each Claude project becomes a project of its own, with its memory (the summary and
    // its memory files) as a knowledge file. Team: the projects are folded into one file of the backup.
    const projects: ExportProject[] =
      withProjects && !team
        ? data.projects.map((p) => {
            const own = data.memoryFiles.filter((f) => memoryFileProject(f.path) === p.sourceId);
            const summary = data.projectMemories[p.sourceId] ?? "";
            if (!summary && own.length === 0) return p;
            const text = [`# Claude memory for this project`, summary, own.length > 0 ? memoryFilesDocument(own) : ""].filter(Boolean).join("\n\n");
            return { ...p, docs: [...p.docs.filter((d) => d.name !== "Claude memory.md"), { name: "Claude memory.md", text }] };
          })
        : [];
    const folded = withProjects && team ? projectsDocument(data.projects, data.projectMemories, data.memoryFiles) : null;
    const generalFiles = data.memoryFiles.filter((f) => memoryFileProject(f.path) === null);
    const chats = data.conversations.filter((c) => c.messages.length > 0);
    const total = projects.length + chats.length + 1;
    let done = 0;
    const result: Outcome = {
      conversations: 0, skipped: 0, empty: data.conversations.length - chats.length, projects: 0, projectsSkipped: 0,
      docs: folded?.docs ?? 0, docsLeft: folded?.left ?? [], memory: memory.trim().length > 0, memoryFiles: data.memoryFiles.length,
      team, destination: team ? TEAM_PROJECT : PRIVATE_PROJECT, members: 0, archive,
    };
    setProgress({ done, total, step: "Preparing the destination project…" });
    try {
      const dest = await importClaudeDestination({ memory: memory.trim(), memoryFiles: generalFiles.length > 0 ? memoryFilesDocument(generalFiles) : "", projectFiles: folded?.text ?? "", team });
      const destination = dest.projectId;
      result.destination = dest.name;
      result.members = dest.members;
      if (folded) result.projects = data.projects.length;
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
            archive,
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
  const destinationName = team ? TEAM_PROJECT : PRIVATE_PROJECT;

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
            Download what the email gives you. Newer exports are several zips, one per part (<code>conversations-000.zip</code>, <code>projects-000.zip</code>, <code>memories-000.zip</code>, plus <code>frames</code> and <code>light_metadata</code>, which are not needed); older ones are a single zip with <code>conversations.json</code> and <code>projects.json</code>. Each download link works once, so save the files.
          </li>
          <li>
            Memory: the <code>memories</code> zip holds it. If your export has none, open <strong>Settings → Memory</strong> in Claude.ai (the Memory entry in the left menu), copy the memory text shown there, and paste it below.
          </li>
        </ol>
        <p className="muted small">Attachments are not in the export; what Claude extracted from them (the text) is, and comes over with the message.</p>
      </section>

      <section className="card">
        <h2>2. Pick the export</h2>
        <div ref={zoneRef} className={`import-drop${dragging ? " dragging" : ""}`}>
          <input ref={fileRef} type="file" accept=".zip,.json,.txt,.md,application/zip,application/json" multiple hidden onChange={(e) => void load(e.target.files)} />
          <p>
            Drop the zip or zips here, or{" "}
            <button type="button" className="link" onClick={() => fileRef.current?.click()} disabled={reading || !!progress}>
              choose the files
            </button>
            {data ? " (more files are added to what is already here)" : ""}.
          </p>
          <p className="muted small">The files are read on this computer. Nothing is sent until you press Import.</p>
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
              <li>
                Memory: {data.memory ? "found in the export" : "not in the export (paste it below if you want it)"}
                {Object.keys(data.projectMemories).length > 0 || data.memoryFiles.length > 0
                  ? `; ${n(Object.keys(data.projectMemories).length)} project memories and ${n(data.memoryFiles.length)} memory files (areas, people, topics), which become project files`
                  : ""}
              </li>
            </ul>
            {data.conversations.length > 0 && data.conversations.every((c) => !c.projectSourceId) && data.projects.length > 0 && (
              <p className="muted small">This export does not say which chats belonged to which project, so every chat lands in "{destinationName}".</p>
            )}
            {data.ignored.length > 0 && (
              <p className="muted small">
                Not used: {data.ignored.slice(0, 6).join(", ")}
                {data.ignored.length > 6 ? ` and ${n(data.ignored.length - 6)} more` : ""}.
              </p>
            )}
            {data.projects.length > 0 && (
              <label className="check">
                <input type="checkbox" checked={includeProjects} onChange={(e) => setIncludeProjects(e.target.checked)} /> Import the projects too (instructions, documents and memory)
              </label>
            )}
          </div>
        )}
      </section>

      <section className="card">
        <h2>3. Who can see it</h2>
        <div className="import-choice" role="radiogroup" aria-label="Destination">
          <label>
            <input type="radio" name="import-destination" checked={!team} onChange={() => setTeam(false)} disabled={!!progress} />
            <span>
              <strong>Only me</strong>: a private project named "{PRIVATE_PROJECT}"
            </span>
            <span className="muted small">The chats are yours alone. Claude projects become private projects of your own, ready for new chats.</span>
          </label>
          <label>
            <input type="radio" name="import-destination" checked={team} onChange={() => setTeam(true)} disabled={!!progress} />
            <span>
              <strong>The whole team</strong>: a shared project named "{TEAM_PROJECT}"
            </span>
            <span className="muted small">
              Everyone with an account becomes a member and sees every imported chat, the memory and the Claude projects (folded into one file of the project), and can continue a chat or ask about anything in them. People who get an account later must be added as members by the project's owner or an administrator. Check the export first: personal chats come over too.
            </span>
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={archive} onChange={(e) => setKeep(e.target.checked)} disabled={!!progress} /> Keep the imported chats as a backup: not deleted after the clinic's retention period (delete them by hand when no longer needed)
        </label>
      </section>

      <section className="card">
        <h2>4. Memory</h2>
        <p className="muted small">
          Becomes the instructions of the "{destinationName}" project, so every conversation there starts with this context; it can be edited there later.
        </p>
        <label htmlFor="import-memory" className="visually-hidden">
          Memory text
        </label>
        <textarea id="import-memory" rows={6} value={memory} onChange={(e) => setMemory(e.target.value)} placeholder="Paste what Claude remembers about you and your work (optional)" disabled={!!progress} maxLength={20000} />
      </section>

      <section className="card">
        <h2>5. Import</h2>
        <p className="muted small">
          Chats keep their messages and dates and can be continued here.{" "}
          {archive
            ? "They are kept as a backup beyond the clinic's retention period, until someone deletes them."
            : "Like every conversation in the assistant, they are kept for the clinic's retention period and then deleted."}{" "}
          Projects and their files stay until you delete them.
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
              {outcome.projects > 0 || outcome.projectsSkipped > 0 ? `; ${n(outcome.projects)} projects with ${n(outcome.docs)} documents${outcome.projectsSkipped > 0 ? ` (${n(outcome.projectsSkipped)} already here)` : ""}${outcome.team ? " (in one file of the project)" : ""}` : ""}
              {outcome.memory ? "; memory saved as the project's instructions" : ""}
              {outcome.memoryFiles > 0 ? `; ${n(outcome.memoryFiles)} memory files saved as project files` : ""}.
            </p>
            <p className="muted small">
              {outcome.team
                ? `Everything is in the shared project "${outcome.destination}", visible to ${n(outcome.members)} other ${outcome.members === 1 ? "person" : "people"}.`
                : `The chats are in the sidebar; the ones from Claude projects are inside those projects.`}
              {outcome.archive ? " The chats are kept as a backup beyond the retention period." : ""}
            </p>
            {outcome.docsLeft.length > 0 && (
              <p className="muted small">
                Too large for the project's file, left out: {outcome.docsLeft.slice(0, 5).join(", ")}
                {outcome.docsLeft.length > 5 ? ` and ${n(outcome.docsLeft.length - 5)} more` : ""}. Upload them to the project as files if they are needed.
              </p>
            )}
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
