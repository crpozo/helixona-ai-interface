import { useCallback, useEffect, useState } from "react";
import { ApiError, adminAgreementUpload, adminConfirmAgreement, adminRemoveAgreement, agreementFileUrl, listAgreements, uploadFile } from "../lib/api";
import { formatSize } from "../lib/files";
import type { Agreement, AgreementsInfo, Me } from "../lib/types";

const dateFmt = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : "Something went wrong. Please try again.";
}

/**
 * The business associate agreements (AWS and Anthropic) on the documentation index: status and where
 * the originals live for everyone; the clinic's PDF copy for signed-in staff; upload and removal for
 * administrators.
 */
export function AgreementsSection({ me }: { me?: Me | null }) {
  const [info, setInfo] = useState<AgreementsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const isAdmin = !!me?.user.roles.includes("admin");

  const load = useCallback(async () => {
    try {
      setInfo(await listAgreements());
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const upload = async (a: Agreement, file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
      setError("Upload the agreement as a PDF.");
      return;
    }
    setProgress((p) => ({ ...p, [a.id]: 0 }));
    try {
      const { upload: target } = await adminAgreementUpload(a.id, { size: file.size, contentType: "application/pdf" });
      await uploadFile(target, file, (fraction) => setProgress((p) => ({ ...p, [a.id]: fraction })));
      await adminConfirmAgreement(a.id);
      await load();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setProgress((p) => {
        const { [a.id]: _done, ...rest } = p;
        return rest;
      });
    }
  };

  const remove = async (a: Agreement) => {
    if (!window.confirm(`Remove the clinic's copy of "${a.title}"? The agreement itself stays in force at ${a.vendor}; only the PDF on file here is deleted.`)) return;
    setError(null);
    try {
      await adminRemoveAgreement(a.id);
      await load();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const copyLine = (a: Agreement) => {
    if (a.file) return `PDF, ${formatSize(a.file.size)}${a.file.uploadedAt ? `, uploaded ${dateFmt.format(new Date(a.file.uploadedAt))}` : ""}`;
    if (!me) return "Sign in to download the clinic's copy";
    return isAdmin ? "None on file yet: upload the PDF from the vendor" : "None on file yet";
  };

  return (
    <section className="docs-agreements" aria-labelledby="docs-agreements">
      <h2 id="docs-agreements">Business associate agreements</h2>
      <p className="docs-agreements-intro">
        The two HIPAA agreements behind the assistant. The originals live with each vendor; the clinic keeps its own PDF copy here, where
        signed-in staff can download it.
      </p>
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      {!info && !error && <p className="muted">Loading…</p>}
      <div className="agreement-cards">
        {(info?.items ?? []).map((a) => {
          const pct = progress[a.id];
          return (
            <article className="agreement-card" key={a.id} aria-labelledby={`agreement-${a.id}`}>
              <p className="eyebrow">{a.vendor}</p>
              <h3 id={`agreement-${a.id}`}>{a.title}</h3>
              <p className="agreement-status">
                <span className="badge badge-ok">In force</span>
                <span>{a.status}</span>
              </p>
              <p className="muted small agreement-note">{a.note}</p>
              <dl className="agreement-meta">
                <dt>Original</dt>
                <dd>{a.reference}</dd>
                <dt>Copy on file</dt>
                <dd>{copyLine(a)}</dd>
              </dl>
              <div className="docs-card-actions">
                {a.file && me && (
                  <a className="btn btn-primary" href={agreementFileUrl(a.id)} download>
                    Download PDF
                  </a>
                )}
                <a className="btn" href={a.url} target="_blank" rel="noreferrer noopener">
                  Open at {a.vendor === "Amazon Web Services" ? "AWS" : a.vendor}
                </a>
                {isAdmin && info?.uploads && (
                  <label className={`btn${pct !== undefined ? " busy" : ""}`}>
                    {pct !== undefined ? `Uploading ${Math.round(pct * 100)}%` : a.file ? "Replace PDF" : "Upload PDF"}
                    <input type="file" accept="application/pdf,.pdf" hidden disabled={pct !== undefined} onChange={(e) => void upload(a, e.target.files?.[0])} />
                  </label>
                )}
                {isAdmin && a.file && (
                  <button type="button" className="btn btn-danger" onClick={() => void remove(a)}>
                    Remove copy
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
