import { useEffect, useRef, useState } from "react";
import type { AttachmentMeta, CatalogModel, Conversation, Project, ProjectVisibility } from "../lib/types";
import { ApiError, createProjectKnowledge, deleteProjectKnowledge, registerProjectKnowledge, updateProject, uploadFile } from "../lib/api";
import { attachmentType, formatSize } from "../lib/files";
import { modelLabel } from "../lib/models";

interface Props {
  project: Project;
  conversations: Conversation[];
  models: CatalogModel[];
  maxMb: number;
  uploadsEnabled: boolean;
  onBack: () => void;
  onOpenConversation: (id: string) => void;
  onNewConversation: () => void;
  onUpdated: (project: Project) => void;
  onDelete: () => void;
}

interface Uploading { localId: string; name: string; progress: number; error: string | null }

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : "Something went wrong. Please try again.";
}

export function ProjectPage({ project, conversations, models, maxMb, uploadsEnabled, onBack, onOpenConversation, onNewConversation, onUpdated, onDelete }: Props) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [instructions, setInstructions] = useState(project.instructions);
  const [visibility, setVisibility] = useState<ProjectVisibility>(project.visibility);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<Uploading[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Reset the form only when switching to another project: updates coming back from a save or a
  // knowledge upload must not clobber what the user is typing or hide the "Saved" notice.
  useEffect(() => {
    setName(project.name);
    setDescription(project.description);
    setInstructions(project.instructions);
    setVisibility(project.visibility);
    setSaveMsg(null);
    setSaveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  const dirty = name !== project.name || description !== project.description || instructions !== project.instructions || visibility !== project.visibility;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    setSaveMsg(null);
    try {
      const updated = await updateProject(project.id, { name: name.trim(), description: description.trim(), instructions, visibility });
      onUpdated(updated);
      setSaveMsg("Saved. New messages in this project's conversations use the updated instructions.");
    } catch (err) {
      setSaveError(errMsg(err));
    } finally {
      setSaving(false);
    }
  };

  const updateUpload = (localId: string, patch: Partial<Uploading>) => setUploads((prev) => prev.map((u) => (u.localId === localId ? { ...u, ...patch } : u)));

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    setFileError(null);
    for (const file of Array.from(files)) {
      const contentType = attachmentType(file);
      if (!contentType) {
        setFileError(`"${file.name}": unsupported type. Use PDF, TXT, MD or CSV.`);
        continue;
      }
      const cap = contentType === "application/pdf" ? maxMb : Math.min(maxMb, 5);
      if (file.size > cap * 1048576) {
        setFileError(`"${file.name}" is larger than ${cap} MB.`);
        continue;
      }
      const localId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setUploads((prev) => [...prev, { localId, name: file.name, progress: 0, error: null }]);
      void (async () => {
        try {
          const created = await createProjectKnowledge(project.id, { name: file.name, size: file.size, contentType });
          await uploadFile(created.upload, file, (f) => updateUpload(localId, { progress: f }));
          const updated = await registerProjectKnowledge(project.id, created.id, created.name);
          onUpdated(updated);
          setUploads((prev) => prev.filter((u) => u.localId !== localId));
        } catch (err) {
          updateUpload(localId, { error: errMsg(err) });
        }
      })();
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  const removeFile = async (k: AttachmentMeta) => {
    if (!window.confirm(`Remove "${k.name}" from this project?`)) return;
    try {
      onUpdated(await deleteProjectKnowledge(project.id, k.id));
    } catch (err) {
      setFileError(errMsg(err));
    }
  };

  const canEdit = project.canEdit;

  return (
    <main className="project-page">
      <header className="admin-head">
        <div>
          <p className="eyebrow">Project</p>
          <h1>{project.name}</h1>
          {project.description && <p className="muted">{project.description}</p>}
        </div>
        <div className="row gap wrap">
          <span className="badge">{project.visibility === "clinic" ? "Shared with the clinic" : "Private"}</span>
          <button type="button" className="btn btn-primary" onClick={onNewConversation}>
            New conversation
          </button>
          <button type="button" className="btn" onClick={onBack}>
            Back
          </button>
        </div>
      </header>

      <section className="card" aria-labelledby="proj-convs">
        <h2 id="proj-convs">Conversations in this project</h2>
        {conversations.length === 0 ? (
          <p className="muted">No conversations yet. Start one and it will use this project's instructions and files.</p>
        ) : (
          <ul className="project-convs">
            {conversations.map((c) => (
              <li key={c.id}>
                <button type="button" className="conv-select" onClick={() => onOpenConversation(c.id)}>
                  <span className="conv-title">{c.title}</span>
                  <span className="conv-meta">
                    {modelLabel(models, c.modelId)} · {dateFmt.format(new Date(c.updatedAt))}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card" aria-labelledby="proj-knowledge">
        <div className="row gap wrap" style={{ justifyContent: "space-between" }}>
          <h2 id="proj-knowledge">Knowledge</h2>
          {canEdit && uploadsEnabled && (
            <>
              <input ref={fileRef} type="file" accept=".pdf,.txt,.md,.csv,application/pdf,text/plain,text/markdown,text/csv" multiple hidden onChange={(e) => addFiles(e.target.files)} />
              <button type="button" className="btn btn-small" onClick={() => fileRef.current?.click()}>
                Add files
              </button>
            </>
          )}
        </div>
        <p className="muted small">Every conversation in this project receives these files automatically. PDF up to {maxMb} MB and 600 pages per file.</p>
        {fileError && (
          <p className="notice notice-error" role="alert">
            {fileError}
          </p>
        )}
        {project.knowledge.length === 0 && uploads.length === 0 && <p className="muted">No files yet.</p>}
        <ul className="attach-list knowledge-list">
          {project.knowledge.map((k) => (
            <li key={k.id} className="attach-chip" title={k.name}>
              <span className="attach-icon" aria-hidden="true">📄</span>
              <span className="attach-name">{k.name}</span>
              <span className="attach-meta">
                {k.pages ? `${k.pages} p · ` : ""}
                {formatSize(k.size)}
              </span>
              {canEdit && (
                <button type="button" className="attach-remove" onClick={() => void removeFile(k)} aria-label={`Remove ${k.name}`}>
                  ×
                </button>
              )}
            </li>
          ))}
          {uploads.map((u) => (
            <li key={u.localId} className={`attach-chip${u.error ? " error" : ""}`} title={u.error ?? u.name}>
              <span className="attach-icon" aria-hidden="true">📄</span>
              <span className="attach-name">{u.name}</span>
              {u.error ? (
                <>
                  <span className="attach-meta">{u.error}</span>
                  <button type="button" className="attach-remove" onClick={() => setUploads((prev) => prev.filter((x) => x.localId !== u.localId))} aria-label={`Dismiss ${u.name}`}>
                    ×
                  </button>
                </>
              ) : (
                <span className="attach-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(u.progress * 100)} aria-label={`Uploading ${u.name}`}>
                  <span style={{ width: `${Math.round(u.progress * 100)}%` }} />
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="card" aria-labelledby="proj-settings">
        <h2 id="proj-settings">Instructions and settings</h2>
        <form onSubmit={save}>
          <div className="form-grid">
            <div>
              <label htmlFor="proj-name">Name</label>
              <input id="proj-name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} />
            </div>
            <div>
              <label htmlFor="proj-visibility">Visibility</label>
              <select id="proj-visibility" value={visibility} onChange={(e) => setVisibility(e.target.value as ProjectVisibility)} disabled={!canEdit}>
                <option value="private">Private (only me)</option>
                <option value="clinic">Shared with the clinic</option>
              </select>
            </div>
          </div>
          <label htmlFor="proj-description">Description</label>
          <input id="proj-description" maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} disabled={!canEdit} />
          <label htmlFor="proj-instructions">Instructions for the assistant</label>
          <textarea id="proj-instructions" rows={8} maxLength={20000} value={instructions} onChange={(e) => setInstructions(e.target.value)} disabled={!canEdit} placeholder="How should the assistant behave in this project? Tone, format, what to always check, templates to follow…" />
          {saveError && (
            <p className="notice notice-error" role="alert">
              {saveError}
            </p>
          )}
          {saveMsg && (
            <p className="notice" role="status">
              {saveMsg}
            </p>
          )}
          {canEdit ? (
            <div className="row gap wrap" style={{ marginTop: "0.75rem" }}>
              <button type="submit" className="btn btn-primary" disabled={saving || !dirty || !name.trim()}>
                {saving ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  if (window.confirm("Delete this project? Its files are removed; conversations are kept without the project context.")) onDelete();
                }}
              >
                Delete project
              </button>
            </div>
          ) : (
            <p className="muted small">Only the project owner or an administrator can edit this project.</p>
          )}
        </form>
      </section>
    </main>
  );
}
