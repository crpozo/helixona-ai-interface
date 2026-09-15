import { Logo } from "./Logo";
import { useState } from "react";
import type { Conversation, Me, Project } from "../lib/types";
import { modelLabel } from "../lib/models";

interface Props {
  me: Me;
  conversations: Conversation[];
  projects: Project[];
  selectedId: string | null;
  projectViewId: string | null;
  open: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => Promise<void>;
  onOpenProject: (id: string) => void;
  onNewProject: () => void;
  onLogout: () => void;
  onAdmin: () => void;
}

export function Sidebar({ me, conversations, projects, selectedId, projectViewId, open, onClose, onSelect, onNew, onDelete, onRename, onOpenProject, onNewProject, onLogout, onAdmin }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const isAdmin = me.user.roles.includes("admin");
  const projectName = (id: string | null | undefined) => (id ? projects.find((p) => p.id === id)?.name ?? null : null);

  const startRename = (c: Conversation) => {
    setEditingId(c.id);
    setDraft(c.title);
  };
  const commitRename = async () => {
    if (!editingId) return;
    const title = draft.trim().slice(0, 80);
    const id = editingId;
    setEditingId(null);
    if (title) await onRename(id, title);
  };

  return (
    <aside id="sidebar" className={`sidebar${open ? " open" : ""}`} aria-label="Conversations">
      <div className="sidebar-head">
        <Logo />
        <button type="button" className="btn btn-icon only-mobile" onClick={onClose} aria-label="Close panel">
          ×
        </button>
      </div>

      <button type="button" className="btn btn-primary block" onClick={onNew}>
        New conversation
      </button>

      <nav className="project-list" aria-label="Projects">
        <div className="section-head">
          <span className="section-title">Projects</span>
          <button type="button" className="btn btn-icon" onClick={onNewProject} aria-label="New project" title="New project">
            +
          </button>
        </div>
        {projects.length === 0 && <p className="muted small">No projects yet. A project gives every conversation in it the same instructions and files.</p>}
        <ul>
          {projects.map((p) => (
            <li key={p.id} className={p.id === projectViewId ? "active" : ""}>
              <button type="button" className="conv-select" aria-current={p.id === projectViewId ? "true" : undefined} onClick={() => onOpenProject(p.id)}>
                <span className="conv-title">{p.name}</span>
                <span className="conv-meta">
                  {p.visibility === "clinic" ? "Shared" : "Private"} · {conversations.filter((c) => c.projectId === p.id).length} chats
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <nav className="conv-list" aria-label="Conversation list">
        <div className="section-head">
          <span className="section-title">Conversations</span>
        </div>
        {conversations.length === 0 && <p className="muted small">You don't have any conversations yet.</p>}
        <ul>
          {conversations.map((c) => (
            <li key={c.id} className={c.id === selectedId ? "active" : ""}>
              {editingId === c.id ? (
                <form
                  className="rename-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void commitRename();
                  }}
                >
                  <label htmlFor={`rename-${c.id}`} className="visually-hidden">
                    New title
                  </label>
                  <input
                    id={`rename-${c.id}`}
                    autoFocus
                    maxLength={80}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setEditingId(null);
                    }}
                  />
                  <button type="submit" className="btn btn-small">
                    Save
                  </button>
                  <button type="button" className="btn btn-small" onClick={() => setEditingId(null)}>
                    Cancel
                  </button>
                </form>
              ) : (
                <div className="conv-row">
                  <button
                    type="button"
                    className="conv-select"
                    aria-current={c.id === selectedId ? "true" : undefined}
                    onClick={() => onSelect(c.id)}
                  >
                    <span className="conv-title">{c.title}</span>
                    <span className="conv-meta">
                      {modelLabel(me.catalog.models, c.modelId)}
                      {projectName(c.projectId) ? ` · ${projectName(c.projectId)}` : ""}
                    </span>
                  </button>
                  <div className="conv-actions">
                    <button type="button" className="btn btn-icon" onClick={() => startRename(c)} aria-label={`Rename: ${c.title}`} title="Rename">
                      ✎
                    </button>
                    <button
                      type="button"
                      className="btn btn-icon"
                      onClick={() => {
                        if (window.confirm("Delete this conversation? All of its messages will be removed.")) onDelete(c.id);
                      }}
                      aria-label={`Delete: ${c.title}`}
                      title="Delete"
                    >
                      🗑
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </nav>

      <div className="sidebar-foot">
        <div className="user-line" title={me.user.email}>
          <span className="user-name">{me.user.name}</span>
          <span className="muted small">{isAdmin ? "Administrator" : "Staff"}</span>
        </div>
        {isAdmin && (
          <a
            href="/admin"
            className="btn block"
            onClick={(e) => {
              e.preventDefault();
              onAdmin();
            }}
          >
            Administration
          </a>
        )}
        <button type="button" className="btn block" onClick={onLogout}>
          Sign out
        </button>
      </div>
    </aside>
  );
}
