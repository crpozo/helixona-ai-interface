import { Logo } from "./Logo";
import { Icon } from "./Icon";
import { BugReport } from "./BugReport";
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
  onNewProject: (visibility: "private" | "shared") => void;
  onLogout: () => void;
  onAdmin: () => void;
  onDocs: () => void;
  onTraining: () => void;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1]![0] ?? "" : "")).toUpperCase() || "?";
}

/** What the sidebar says next to a project that is not private. */
export function projectTag(p: Project): string {
  if (p.visibility === "clinic") return "Clinic";
  return p.members.length > 0 ? `${p.members.length + 1} people` : "Shared";
}

/**
 * Sidebar organized like Claude.ai: a short list of plain links at the top (new chat, training,
 * documentation, administration), then the user's own projects and the shared ones, each with its
 * chats nested underneath, then the chats that belong to no project, and the signed-in user at the
 * bottom. Rows are text with an icon; the actions (rename, delete, new chat in a project) appear on hover.
 */
export function Sidebar({ me, conversations, projects, selectedId, projectViewId, open, onClose, onSelect, onNew, onNewInProject, onDelete, onRename, onOpenProject, onNewProject, onLogout, onAdmin, onDocs, onTraining }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const isAdmin = me.user.roles.includes("admin");
  const mine = projects.filter((p) => p.visibility === "private");
  const shared = projects.filter((p) => p.visibility !== "private");
  // A chat whose project is gone (deleted, or no longer shared with this person) is listed with the loose ones.
  const loose = conversations.filter((c) => !c.projectId || !projects.some((p) => p.id === c.projectId));

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

  const link = (href: string, label: string, icon: "cap" | "book" | "sliders", go: () => void) => (
    <a
      href={href}
      className="side-link"
      onClick={(e) => {
        e.preventDefault();
        go();
      }}
    >
      <Icon name={icon} />
      <span>{label}</span>
    </a>
  );

  const conversationItem = (c: Conversation, inSharedProject = false) => (
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
            onBlur={(e) => {
              // Leaving the editor saves, unless focus moved to its own Save/Cancel buttons.
              if (!(e.relatedTarget instanceof Node && e.currentTarget.form?.contains(e.relatedTarget))) void commitRename();
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
            title={`${c.title} · ${modelLabel(me.catalog.models, c.modelId)}${inSharedProject && c.createdByName ? ` · started by ${c.createdByName}` : ""}`}
          >
            <Icon name="chat" size={15} className="conv-icon" />
            <span className="conv-title">{c.title}</span>
          </button>
          <div className="conv-actions">
            <button type="button" className="icon-btn" onClick={() => startRename(c)} aria-label={`Rename: ${c.title}`} title="Rename">
              <Icon name="pencil" size={15} />
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => {
                if (window.confirm("Delete this conversation? All of its messages will be removed.")) onDelete(c.id);
              }}
              aria-label={`Delete: ${c.title}`}
              title="Delete"
            >
              <Icon name="trash" size={15} />
            </button>
          </div>
        </div>
      )}
    </li>
  );

  const projectGroup = (p: Project) => {
    const chats = conversations.filter((c) => c.projectId === p.id);
    const isCollapsed = collapsed[p.id] ?? false;
    const inShared = p.visibility === "shared";
    const kind = p.visibility === "clinic" ? "Shared with the clinic" : p.visibility === "shared" ? `Shared with ${p.members.length + 1} people` : "Private";
    return (
      <li key={p.id} className={`project-group${p.id === projectViewId ? " active" : ""}`}>
        <div className="project-row">
          <button
            type="button"
            className="icon-btn chevron"
            onClick={() => setCollapsed((prev) => ({ ...prev, [p.id]: !isCollapsed }))}
            aria-expanded={!isCollapsed}
            aria-label={isCollapsed ? `Show chats in ${p.name}` : `Hide chats in ${p.name}`}
            title={isCollapsed ? "Show chats" : "Hide chats"}
          >
            <Icon name="chevron" size={14} className={isCollapsed ? "" : "rotated"} />
          </button>
          <button
            type="button"
            className="conv-select project-select"
            aria-current={p.id === projectViewId ? "true" : undefined}
            onClick={() => onOpenProject(p.id)}
            title={`${p.name} · ${kind} · ${chats.length} ${chats.length === 1 ? "chat" : "chats"}`}
          >
            <Icon name="folder" size={15} className="conv-icon" />
            <span className="conv-title">{p.name}</span>
            {p.visibility !== "private" && <span className="side-tag">{projectTag(p)}</span>}
          </button>
          <button type="button" className="icon-btn row-action" onClick={() => onNewInProject(p.id)} aria-label={`New chat in ${p.name}`} title="New chat in this project">
            <Icon name="plus" size={15} />
          </button>
        </div>
        {!isCollapsed && (
          <ul className="project-chats" aria-label={`Chats in ${p.name}`}>
            {chats.length === 0 && <li className="muted small project-empty">No chats yet</li>}
            {chats.map((c) => conversationItem(c, inShared))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <aside id="sidebar" className={`sidebar${open ? " open" : ""}`} aria-label="Conversations">
      <div className="sidebar-head">
        <Logo />
        <button type="button" className="icon-btn only-mobile" onClick={onClose} aria-label="Close panel">
          <Icon name="close" />
        </button>
      </div>

      <nav className="side-nav" aria-label="Main">
        <button type="button" className="side-link side-link-new" onClick={onNew}>
          <span className="side-link-plus">
            <Icon name="plus" size={15} />
          </span>
          <span>New conversation</span>
        </button>
        {link("/training", "Training", "cap", onTraining)}
        {link("/documentation", "Documentation", "book", onDocs)}
        {isAdmin && link("/admin", "Administration", "sliders", onAdmin)}
        <BugReport />
      </nav>

      <div className="sidebar-scroll">
        <nav className="project-list" aria-label="Projects">
          <div className="section-head">
            <span className="section-title">Projects</span>
            <button type="button" className="icon-btn" onClick={() => onNewProject("private")} aria-label="New project" title="New project">
              <Icon name="plus" size={15} />
            </button>
          </div>
          {mine.length === 0 && <p className="muted small side-empty">No projects yet. A project gives every conversation in it the same instructions and files.</p>}
          <ul>{mine.map(projectGroup)}</ul>
        </nav>

        <nav className="project-list shared-project-list" aria-label="Shared projects">
          <div className="section-head">
            <span className="section-title">Shared projects</span>
            <button type="button" className="icon-btn" onClick={() => onNewProject("shared")} aria-label="New shared project" title="New shared project">
              <Icon name="plus" size={15} />
            </button>
          </div>
          {shared.length === 0 && <p className="muted small side-empty">No shared projects yet. In a shared project, the people you choose see and continue the same chats.</p>}
          <ul>{shared.map(projectGroup)}</ul>
        </nav>

        <nav className="conv-list" aria-label="Conversation list">
          <div className="section-head">
            <span className="section-title">Chats</span>
          </div>
          {loose.length === 0 && <p className="muted small side-empty">{conversations.length === 0 ? "You don't have any conversations yet." : "All your conversations are in projects."}</p>}
          <ul>{loose.map((c) => conversationItem(c))}</ul>
        </nav>
      </div>

      <div className="sidebar-foot">
        <div className="user-row" title={me.user.email}>
          <span className="avatar" aria-hidden="true">
            {initials(me.user.name)}
          </span>
          <span className="user-line">
            <span className="user-name">{me.user.name}</span>
            <span className="muted small">{isAdmin ? "Administrator" : "Staff"}</span>
          </span>
          <button type="button" className="icon-btn" onClick={onLogout} aria-label="Sign out" title="Sign out">
            <Icon name="logout" size={17} />
          </button>
        </div>
      </div>
    </aside>
  );
}
