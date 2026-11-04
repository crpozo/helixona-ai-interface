import { useContext, useEffect, useState } from "react";
import type { PackageItem, PackageManifest } from "../lib/types";
import { ApiError, getPackage, packageDownloadUrl, rebuildPackage } from "../lib/api";
import { DocumentViewerContext } from "../lib/documentViewer";
import { formatSize } from "../lib/files";

interface Props {
  conversationId: string;
  id: string;
  title: string;
  /** The manifest when the package was built in this session; a saved message loads it. */
  initial: PackageManifest | null;
}

const ROWS_SHOWN = 6;

function sourceLabel(item: PackageItem): string {
  return item.source === "summary" ? "generated" : item.source === "project" ? "project file" : "";
}

/**
 * A package the assistant built: the index with page numbers, Download PDF / ZIP, the summary in the
 * viewer, and an editor to add, remove or reorder documents (the summary stays first).
 */
export function PackageCard({ conversationId, id, title, initial }: Props) {
  const [manifest, setManifest] = useState<PackageManifest | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [allRows, setAllRows] = useState(false);
  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const openViewer = useContext(DocumentViewerContext);

  useEffect(() => {
    if (initial) setManifest(initial);
  }, [initial]);
  useEffect(() => {
    if (manifest) return;
    let alive = true;
    getPackage(conversationId, id)
      .then((m) => alive && setManifest(m))
      .catch((e) => alive && setError(e instanceof ApiError ? `This package is no longer available (${e.code}).` : "This package could not be loaded."));
    return () => {
      alive = false;
    };
  }, [conversationId, id, manifest]);

  const included = manifest?.items.filter((i) => i.included) ?? [];
  const documents = included.length - 1;
  const available = manifest?.items.filter((i) => !i.included) ?? [];
  const rows = allRows ? included : included.slice(0, ROWS_SHOWN);
  const name = manifest?.title ?? title;

  const startEditing = () => {
    setPicked(included.filter((i) => i.source !== "summary").map((i) => i.id));
    setEditing(true);
  };
  const move = (docId: string, dir: -1 | 1) =>
    setPicked((prev) => {
      const i = prev.indexOf(docId);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      setManifest(await rebuildPackage(conversationId, id, picked));
      setEditing(false);
    } catch (e) {
      setError(e instanceof ApiError ? `The package could not be rebuilt (${e.code}).` : "The package could not be rebuilt.");
    } finally {
      setBusy(false);
    }
  };

  const byId = new Map((manifest?.items ?? []).map((i) => [i.id, i]));
  const editorRows: PackageItem[] = [...picked.map((d) => byId.get(d)).filter((i): i is PackageItem => !!i), ...(manifest?.items ?? []).filter((i) => i.source !== "summary" && !picked.includes(i.id))];

  return (
    <div className="doc-card package-card" role="group" aria-label={`Package: ${name}`}>
      <div className="doc-card-main">
        <span className="doc-icon package-icon" aria-hidden="true">
          PKG
        </span>
        <span className="doc-card-text">
          <span className="doc-title" title={name}>
            {name}.pdf
          </span>
          <span className="doc-kind">
            {manifest ? `${documents === 1 ? "1 document" : `${documents} documents`} after the summary · ${manifest.pages} pages · ${formatSize(manifest.bytes)} · also as ZIP with the summary in Markdown` : error ? "Package" : "Loading…"}
          </span>
        </span>
      </div>

      {manifest && !editing && (
        <ol className="package-index" aria-label="Contents">
          <li className="package-row">
            <span className="package-num">–</span>
            <span className="package-name">Cover and index</span>
            <span className="package-page">p. 1</span>
          </li>
          {rows.map((item, n) => (
            <li key={item.id} className="package-row">
              <span className="package-num">{n + 1}</span>
              <span className="package-name">
                {item.source === "summary" ? "Summary" : item.name}
                {sourceLabel(item) && <span className={`package-tag${item.source === "summary" ? " gold" : ""}`}>{sourceLabel(item)}</span>}
                {item.note && <span className="package-note">{item.note}</span>}
              </span>
              <span className="package-page">{item.startPage ? (item.mergedPages && item.mergedPages > 1 ? `p. ${item.startPage}–${item.startPage + item.mergedPages - 1}` : `p. ${item.startPage}`) : ""}</span>
            </li>
          ))}
          {included.length > ROWS_SHOWN && (
            <li className="package-row">
              <span className="package-num">…</span>
              <button type="button" className="attach-more" aria-expanded={allRows} onClick={() => setAllRows((v) => !v)}>
                {allRows ? "Show fewer" : `${included.length - ROWS_SHOWN} more documents`}
              </button>
            </li>
          )}
        </ol>
      )}

      {manifest && editing && (
        <fieldset className="package-editor" aria-label={`Contents of ${name}`}>
          <legend className="visually-hidden">Choose the documents</legend>
          <div className="package-row fixed">
            <span className="package-num">1</span>
            <span className="package-name">
              Summary <span className="package-tag gold">generated</span>
            </span>
            <span className="package-page muted">always first</span>
          </div>
          {editorRows.map((item) => {
            const on = picked.includes(item.id);
            const pos = picked.indexOf(item.id);
            return (
              <label key={item.id} className={`package-row pick${on ? "" : " off"}`}>
                <input type="checkbox" checked={on} disabled={busy} onChange={(e) => setPicked((prev) => (e.target.checked ? [...prev, item.id] : prev.filter((d) => d !== item.id)))} />
                <span className="package-num">{on ? pos + 2 : ""}</span>
                <span className="package-name">
                  {item.name}
                  {item.source === "project" && <span className="package-tag">project file</span>}
                </span>
                <span className="package-page muted">{item.pages ? `${item.pages} p.` : ""}</span>
                {on && (
                  <span className="package-order">
                    <button type="button" className="icon-btn" aria-label={`Move ${item.name} up`} disabled={busy || pos === 0} onClick={() => move(item.id, -1)}>
                      ↑
                    </button>
                    <button type="button" className="icon-btn" aria-label={`Move ${item.name} down`} disabled={busy || pos === picked.length - 1} onClick={() => move(item.id, 1)}>
                      ↓
                    </button>
                  </span>
                )}
              </label>
            );
          })}
          {available.length === 0 && included.length <= 1 && <p className="muted small">No document in this conversation can be added (PDFs, images and text files can be packaged).</p>}
        </fieldset>
      )}

      {error && (
        <p className="notice notice-error small" role="alert">
          {error}
        </p>
      )}

      <div className="doc-card-actions package-actions">
        {editing ? (
          <>
            <button type="button" className="btn btn-primary btn-small" disabled={busy} onClick={() => void apply()}>
              {busy ? "Rebuilding…" : "Apply"}
            </button>
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
            <span className="muted small">{picked.length === 1 ? "1 document" : `${picked.length} documents`} after the summary</span>
          </>
        ) : (
          <>
            <a className="btn btn-primary btn-small" href={manifest ? packageDownloadUrl(conversationId, id, "pdf") : undefined} download={`${name}.pdf`} aria-disabled={!manifest} aria-label={`Download ${name} as PDF`}>
              Download PDF
            </a>
            <a className="btn btn-small" href={manifest ? packageDownloadUrl(conversationId, id, "zip") : undefined} download={`${name}.zip`} aria-disabled={!manifest} aria-label={`Download ${name} as ZIP`}>
              Download ZIP
            </a>
            {manifest && openViewer && (
              <button type="button" className="btn btn-small btn-ghost" onClick={() => openViewer({ markdown: manifest.summary, format: "pdf", title: `${name} – summary` })}>
                Open summary
              </button>
            )}
            {manifest && (
              <button type="button" className="btn btn-small btn-ghost" onClick={startEditing}>
                Change contents
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
