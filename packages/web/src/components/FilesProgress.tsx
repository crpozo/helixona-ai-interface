import type { SseFileProgress, SseFiles } from "../lib/types";

interface Props {
  files: SseFiles;
  /** The turn is still running (a stopped or failed turn shows where the reading got to). */
  active: boolean;
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

function stateLabel(f: SseFileProgress): string {
  switch (f.state) {
    case "checking":
      return "Checking…";
    case "queued":
      return "Waiting";
    case "reading":
      return f.pages ? `${f.pagesDone.toLocaleString("en-US")} of ${f.pages.toLocaleString("en-US")} pages` : `${f.pagesDone.toLocaleString("en-US")} pages`;
    case "done":
      return "Done";
    case "failed":
      return "Some pages not read";
  }
}

/**
 * What the server does with large attachments before it answers: checking them, then reading them a
 * few pages at a time (with a line per file), then a one-line summary above the answer.
 */
export function FilesProgress({ files, active }: Props) {
  const list = files.files;
  const pages = list.reduce((n, f) => n + (f.pages ?? 0), 0);
  const done = list.reduce((n, f) => n + f.pagesDone, 0);
  const failed = list.filter((f) => f.state === "failed");

  if (files.phase === "checking") {
    return active ? (
      <p className="files-progress-line" role="status">
        <span className="dot" aria-hidden="true" /> Checking {plural(list.length, "file", "files")}…
      </p>
    ) : null;
  }

  if (files.phase === "reading" && !active) {
    return (
      <p className="files-progress-line" role="status">
        Reading stopped at {plural(done, "page", "pages")}{pages ? ` of ${pages.toLocaleString("en-US")}` : ""}. The pages already read are kept: send the message again to continue.
      </p>
    );
  }

  if (files.phase === "reading") {
    return (
      <div className="files-progress" role="status" aria-live="polite">
        <p className="files-progress-head">
          <span className="dot" aria-hidden="true" /> Reading {plural(list.length, "large file", "large files")} page by page
          {pages ? ` (${pages.toLocaleString("en-US")} pages)` : ""}…
        </p>
        <ul className="file-lines">
          {list.map((f) => {
            const pct = f.pages ? Math.round((Math.min(f.pagesDone, f.pages) / f.pages) * 100) : 0;
            return (
              <li key={f.id} className={`file-line ${f.state}`}>
                <span className="file-name" title={f.name}>
                  {f.name}
                </span>
                <span className="file-state">{stateLabel(f)}</span>
                {f.pages ? (
                  <span className="file-bar" role="progressbar" aria-valuemin={0} aria-valuemax={f.pages} aria-valuenow={Math.min(f.pagesDone, f.pages)} aria-label={`${f.name}: ${f.pagesDone} of ${f.pages} pages read`}>
                    <span style={{ width: `${pct}%` }} />
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
        <p className="muted small">Values are copied from the page images; check them against the originals before you rely on them.</p>
      </div>
    );
  }

  return (
    <div className="files-read">
      <p className="files-progress-line">
        Read {plural(list.length, "large file", "large files")} page by page{pages ? ` · ${plural(pages, "page", "pages")}` : ""}
      </p>
      {failed.map((f) => (
        <p key={f.id} className="notice notice-error">
          {f.name}: {f.note ?? "some pages could not be read."}
        </p>
      ))}
    </div>
  );
}
