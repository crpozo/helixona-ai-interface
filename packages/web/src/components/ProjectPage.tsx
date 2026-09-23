import { useEffect, useRef, useState } from "react";
import type { AttachmentMeta, CatalogModel, Conversation, Project, ProjectVisibility } from "../lib/types";
import { ApiError, createProjectKnowledge, deleteProjectKnowledge, registerProjectKnowledge, updateProject, uploadFile } from "../lib/api";
import { attachmentType, formatSize } from "../lib/files";
import { modelLabel } from "../lib/models";
import { useFileDrop } from "../lib/useFileDrop";
import { ProjectMembers } from "./ProjectMembers";
import { StartComposer } from "./StartComposer";
import { Icon } from "./Icon";

interface Props {
  project: Project;
  conversations: Conversation[];
  models: CatalogModel[];
  defaultAlias: string;
  maxMb: number;
  uploadsEnabled: boolean;
  /** Upload limits for files sent with the first message; null when uploads are off. */
  attachments?: { maxMb: number; maxPerMessage: number } | null;
  /** The signed-in user (named "You" in the members list). */
  meId: string;
  onBack: () => void;
  onOpenConversation: (id: string) => void;
  /** Starts a conversation in this project with its first message; resolves once it exists. */
  onStartConversation: (text: string, modelAlias: string, files: File[]) => Promise<void>;
  onUpdated: (project: Project) => void;
  onDelete: () => void;
}

interface Uploading { localId: string; name: string; progress: number; error: string | null }

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const CLAMP_CHARS = 420;

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : "Something went wrong. Please try again.";
}

/** "Just now", "12 min ago", "3 hours ago", "5 days ago", then the date. */
export function relativeTime(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return dayFmt.format(new Date(iso));
}

/** The badge next to the project's name. */
export function visibilityLabel(p: Project): string {
  if (p.visibility === "clinic") return "Shared with the clinic";
  if (p.visibility === "shared") return `Shared · ${p.members.length + 1} ${p.members.length + 1 === 1 ? "person" : "people"}`;
  return "Private";
}

export function ProjectPage({ project, conversations, models, defaultAlias, maxMb, uploadsEnabled, attachments = null, meId, onBack, onOpenConversation, onStartConversation, onUpdated, onDelete }: Props) {
  // Settings card (name, description, visibility).
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [visibility, setVisibility] = useState<ProjectVisibility>(project.visibility);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // The title, edited in place (the Settings card has the same field). The draft also lives in a ref
  // so a blur that fires while the editor closes reads the current text, not a stale one.
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(project.name);
  const [titleError, setTitleError] = useState<string | null>(null);
  const titleDraftRef = useRef(project.name);
  const titleCommitting = useRef(false);
  // Instructions card, edited in place.
  const [editingInstructions, setEditingInstructions] = useState(false);
  const [instructionsDraft, setInstructionsDraft] = useState(project.instructions);
  const [savingInstructions, setSavingInstructions] = useState(false);
  const [instructionsError, setInstructionsError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  // Knowledge card.
  const [uploads, setUploads] = useState<Uploading[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const knowledgeRef = useRef<HTMLElement>(null);

  // Reset the forms only when switching to another project: updates coming back from a save or a
  // knowledge upload must not clobber what the user is typing or hide the "Saved" notice.
  useEffect(() => {
    setName(project.name);
    setDescription(project.description);
    setVisibility(project.visibility);
    setSaveMsg(null);
    setSaveError(null);
    setEditingInstructions(false);
    setInstructionsDraft(project.instructions);
    setInstructionsError(null);
    setExpanded(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);
  // Visibility can be changed by a colleague (or the members list can change): keep the select honest.
  useEffect(() => {
    setVisibility(project.visibility);
  }, [project.visibility]);
  // A rename (from the title, the sidebar or a colleague) shows up in the Settings form too.
  useEffect(() => {
    setName(project.name);
    setTitleDraft(project.name);
    titleDraftRef.current = project.name;
    setEditingTitle(false);
  }, [project.name]);

  const dirty = name !== project.name || description !== project.description || visibility !== project.visibility;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (visibility === "shared" && project.visibility !== "shared" && conversations.length > 0) {
      const n = conversations.length;
      if (!window.confirm(`Everyone you add to this project will see and can continue ${n === 1 ? "the chat" : `all ${n} chats`} already in it. Share the project?`)) return;
    }
    if (visibility !== "shared" && project.visibility === "shared" && project.members.length > 0) {
      if (!window.confirm("The people in this project will lose access to it. Chats they started go back to them, outside the project. Continue?")) return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveMsg(null);
    try {
      onUpdated(await updateProject(project.id, { name: name.trim(), description: description.trim(), visibility }));
      setSaveMsg("Saved.");
    } catch (err) {
      setSaveError(errMsg(err));
    } finally {
      setSaving(false);
    }
  };

  const saveInstructions = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingInstructions(true);
    setInstructionsError(null);
    try {
      onUpdated(await updateProject(project.id, { instructions: instructionsDraft }));
      setEditingInstructions(false);
    } catch (err) {
      setInstructionsError(errMsg(err));
    } finally {
      setSavingInstructions(false);
    }
  };

  const startTitleEdit = () => {
    if (!project.canEdit) return;
    setTitleDraft(project.name);
    titleDraftRef.current = project.name;
    setTitleError(null);
    setEditingTitle(true);
  };
  const cancelTitleEdit = () => {
    titleDraftRef.current = project.name;
    setEditingTitle(false);
  };
  const commitTitle = async () => {
    if (titleCommitting.current) return;
    titleCommitting.current = true;
    const next = titleDraftRef.current.trim().slice(0, 80);
    setEditingTitle(false);
    try {
      if (next && next !== project.name) onUpdated(await updateProject(project.id, { name: next }));
    } catch (err) {
      setTitleError(errMsg(err));
    } finally {
      titleCommitting.current = false;
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
  const canManage = project.canManage;
  const canUpload = !!canEdit && uploadsEnabled;
  const isShared = project.visibility === "shared";
  // Drop files onto the Knowledge card to add them to the project.
  const dragging = useFileDrop(knowledgeRef, addFiles, canUpload);
  const recents = [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const longInstructions = project.instructions.length > CLAMP_CHARS;

  return (
    <main className="project-page">
      <nav className="crumbs" aria-label="Breadcrumb">
        <button type="button" className="link" onClick={onBack}>
          {project.visibility === "private" ? "Projects" : "Shared projects"}
        </button>
        <span className="crumb-sep" aria-hidden="true">
          /
        </span>
        <span className="current" aria-current="page">
          {project.name}
        </span>
      </nav>

      <header className="project-head">
        <div className="project-head-text">
          {editingTitle ? (
            <form
              className="project-title-form"
              onSubmit={(e) => {
                e.preventDefault();
                void commitTitle();
              }}
            >
              <label htmlFor="proj-title" className="visually-hidden">
                Project name
              </label>
              <input
                id="proj-title"
                className="project-title-input"
                autoFocus
                required
                maxLength={80}
                value={titleDraft}
                onChange={(e) => {
                  setTitleDraft(e.target.value);
                  titleDraftRef.current = e.target.value;
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") cancelTitleEdit();
                }}
                onBlur={() => void commitTitle()}
              />
            </form>
          ) : (
            <div className="project-title-row">
              <h1 className={`project-title${canEdit ? " editable" : ""}`} onClick={startTitleEdit} title={canEdit ? "Click to rename" : undefined}>
                {project.name}
              </h1>
              {canEdit && (
                <button type="button" className="icon-btn title-edit" onClick={startTitleEdit} aria-label={`Rename project: ${project.name}`} title="Rename">
                  <Icon name="pencil" size={16} />
                </button>
              )}
            </div>
          )}
          {titleError && (
            <p className="notice notice-error" role="alert">
              {titleError}
            </p>
          )}
          {project.description && <p className="project-desc">{project.description}</p>}
        </div>
        <span className="badge">{visibilityLabel(project)}</span>
      </header>

      <div className="project-grid">
        <div className="project-main">
          <StartComposer models={models} defaultAlias={defaultAlias} attachments={attachments} onStart={onStartConversation} />

          <section className="project-recents" aria-labelledby="proj-recents">
            <h2 id="proj-recents" className="section-label">
              Recents
            </h2>
            {recents.length === 0 ? (
              <p className="muted">
                {isShared
                  ? "No conversations yet. The first message above starts one that everyone in this project sees."
                  : "No conversations yet. Your first message above starts one with this project's instructions and files."}
              </p>
            ) : (
              <ul className="recent-list">
                {recents.map((c) => (
                  <li key={c.id}>
                    <button type="button" className="recent-row" onClick={() => onOpenConversation(c.id)}>
                      <span className="recent-title">{c.title}</span>
                      <span className="recent-meta" title={dateFmt.format(new Date(c.updatedAt))}>
                        {isShared && c.createdByName ? `started by ${c.createdBy === meId ? "you" : c.createdByName} · ` : ""}
                        {modelLabel(models, c.modelId)} · {relativeTime(c.updatedAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="project-side">
          <ProjectMembers project={project} meId={meId} onUpdated={onUpdated} />

          <section className="side-card" aria-labelledby="proj-instructions-h">
            <div className="side-card-head">
              <h2 id="proj-instructions-h">Instructions</h2>
              {canEdit && !editingInstructions && (
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => {
                    setInstructionsDraft(project.instructions);
                    setInstructionsError(null);
                    setEditingInstructions(true);
                  }}
                >
                  {project.instructions ? "Edit" : "Add"}
                </button>
              )}
            </div>
            {editingInstructions ? (
              <form onSubmit={saveInstructions}>
                <label htmlFor="proj-instructions" className="visually-hidden">
                  Instructions for the assistant
                </label>
                <textarea
                  id="proj-instructions"
                  rows={8}
                  maxLength={20000}
                  value={instructionsDraft}
                  onChange={(e) => setInstructionsDraft(e.target.value)}
                  placeholder="How should the assistant behave in this project? Tone, format, what to always check, templates to follow…"
                  autoFocus
                />
                {instructionsError && (
                  <p className="notice notice-error" role="alert">
                    {instructionsError}
                  </p>
                )}
                <div className="row gap wrap side-actions">
                  <button type="submit" className="btn btn-primary btn-small" disabled={savingInstructions}>
                    {savingInstructions ? "Saving…" : "Save"}
                  </button>
                  <button type="button" className="btn btn-small" onClick={() => setEditingInstructions(false)} disabled={savingInstructions}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : project.instructions ? (
              <>
                <p className={`side-text${longInstructions && !expanded ? " clamped" : ""}`}>{project.instructions}</p>
                {longInstructions && (
                  <button type="button" className="link small" onClick={() => setExpanded((v) => !v)}>
                    {expanded ? "Show less" : "Show more"}
                  </button>
                )}
              </>
            ) : (
              <p className="muted small">Add instructions to tailor the assistant's responses in this project.</p>
            )}
          </section>

          <section className="side-card drop-zone" aria-labelledby="proj-knowledge-h" ref={knowledgeRef}>
            {dragging && (
              <div className="drop-overlay" aria-hidden="true">
                <div className="drop-card">
                  <strong>Drop to add to the project</strong>
                  <span>PDF up to {maxMb} MB, TXT, MD or CSV</span>
                </div>
              </div>
            )}
            <div className="side-card-head">
              <h2 id="proj-knowledge-h">Knowledge</h2>
              {canUpload && (
                <>
                  <input ref={fileRef} type="file" accept=".pdf,.txt,.md,.csv,application/pdf,text/plain,text/markdown,text/csv" multiple hidden onChange={(e) => addFiles(e.target.files)} />
                  <button type="button" className="btn btn-small" onClick={() => fileRef.current?.click()}>
                    Add files
                  </button>
                </>
              )}
            </div>
            {fileError && (
              <p className="notice notice-error" role="alert">
                {fileError}
              </p>
            )}
            {project.knowledge.length === 0 && uploads.length === 0 && (
              <p className="muted small">
                Files the assistant reads in every conversation of this project.{canUpload ? ` Drag them here or use Add files. PDF up to ${maxMb} MB and 600 pages per file.` : ""}
              </p>
            )}
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

          <section className="side-card" aria-labelledby="proj-settings-h">
            <div className="side-card-head">
              <h2 id="proj-settings-h">Settings</h2>
            </div>
            {canEdit ? (
              <form onSubmit={save}>
                <label htmlFor="proj-name">Name</label>
                <input id="proj-name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
                <label htmlFor="proj-description">Description</label>
                <input id="proj-description" maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this project is for" />
                <label htmlFor="proj-visibility">Visibility</label>
                <select id="proj-visibility" value={visibility} disabled={!canManage} onChange={(e) => setVisibility(e.target.value as ProjectVisibility)} title={canManage ? undefined : "Only the project owner or an administrator can change who sees this project"}>
                  <option value="private">Private (only me)</option>
                  <option value="shared">Shared with chosen people (same chats for everyone)</option>
                  <option value="clinic">Shared with the clinic (instructions and files; chats stay personal)</option>
                </select>
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
                <div className="row gap wrap side-actions">
                  <button type="submit" className="btn btn-primary btn-small" disabled={saving || !dirty || !name.trim()}>
                    {saving ? "Saving…" : "Save"}
                  </button>
                  {canManage && (
                    <button
                      type="button"
                      className="btn btn-danger btn-small"
                      onClick={() => {
                        const question = isShared
                          ? "Delete this shared project? Its files are removed; each chat goes back to the person who started it, outside the project."
                          : "Delete this project? Its files are removed; conversations are kept without the project context.";
                        if (window.confirm(question)) onDelete();
                      }}
                    >
                      Delete project
                    </button>
                  )}
                </div>
              </form>
            ) : (
              <p className="muted small">Only the project owner or an administrator can edit this project.</p>
            )}
          </section>
        </aside>
      </div>
    </main>
  );
}
