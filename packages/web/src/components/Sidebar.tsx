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
  onNewInProject: (projectId: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => Promise<void>;
  onOpenProject: (id: string) => void;
  onNewProject: () => void;
  onLogout: () => void;
  onAdmin: () => void;
  onDocs: () => void;
}

/**
 * Sidebar laid out like Claude.ai: each project is a group with its chats nested underneath, and
 * the Conversations list holds only the chats that belong to no project.
 */
export function Sidebar({ me, conversations, projects, selectedId, projectViewId, open, onClose, onSelect, onNew, onNewInProject, onDelete, onRename, onOpenProject, onNewProject, onLogout, onAdmin, onDocs }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const isAdmin = me.user.roles.includes("admin");
  const loose = conversations.filter((c) => !c.projectId);

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

  const conversationItem = (c: Conversation) => (
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
          <button type="button" className="conv-select" aria-current={c.id === selectedId ? "true" : undefined} onClick={() => onSelect(c.id)}>
            <span className="conv-title">{c.title}</span>
            <span className="conv-meta">{modelLabel(me.catalog.models, c.modelId)}</span>
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
  );

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

      <div className="sidebar-scroll">
        <nav className="project-list" aria-label="Projects">
          <div className="section-head">
            <span className="section-title">Projects</span>
            <button type="button" className="btn btn-icon" onClick={onNewProject} aria-label="New project" title="New project">
              +
            </button>
          </div>
          {projects.length === 0 && <p className="muted small">No projects yet. A project gives every conversation in it the same instructions and files.</p>}
          <ul>
            {projects.map((p) => {
              const chats = conversations.filter((c) => c.projectId === p.id);
              const isCollapsed = collapsed[p.id] ?? false;
              return (
                <li key={p.id} className={`project-group${p.id === projectViewId ? " active" : ""}`}>
                  <div className="project-row">
                    <button
                      type="button"
                      className="btn btn-icon chevron"
                      onClick={() => setCollapsed((prev) => ({ ...prev, [p.id]: !isCollapsed }))}
                      aria-expanded={!isCollapsed}
                      aria-label={isCollapsed ? `Show chats in ${p.name}` : `Hide chats in ${p.name}`}
                      title={isCollapsed ? "Show chats" : "Hide chats"}
                    >
                      {isCollapsed ? "▸" : "▾"}
                    </button>
                    <button type="button" className="conv-select project-select" aria-current={p.id === projectViewId ? "true" : undefined} onClick={() => onOpenProject(p.id)} title="Open project">
                      <span className="conv-title">{p.name}</span>
                      <span className="conv-meta">
                        {p.visibility === "clinic" ? "Shared" : "Private"} · {chats.length} {chats.length === 1 ? "chat" : "chats"}
                      </span>
                    </button>
                    <button type="button" className="btn btn-icon" onClick={() => onNewInProject(p.id)} aria-label={`New chat in ${p.name}`} title="New chat in this project">
                      +
                    </button>
                  </div>
                  {!isCollapsed && (
                    <ul className="project-chats" aria-label={`Chats in ${p.name}`}>
                      {chats.length === 0 && (
                        <li className="muted small project-empty">No chats yet</li>
                      )}
                      {chats.map(conversationItem)}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>

        <nav className="conv-list" aria-label="Conversation list">
          <div className="section-head">
            <span className="section-title">Conversations</span>
          </div>
          {loose.length === 0 && <p className="muted small">{conversations.length === 0 ? "You don't have any conversations yet." : "All your conversations are in projects."}</p>}
          <ul>{loose.map(conversationItem)}</ul>
        </nav>
      </div>

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
        <a
          href="/documentation"
          className="btn block"
          onClick={(e) => {
            e.preventDefault();
            onDocs();
          }}
        >
          Documentation
        </a>
        <button type="button" className="btn block" onClick={onLogout}>
          Sign out
        </button>
      </div>
    </aside>
  );
}
