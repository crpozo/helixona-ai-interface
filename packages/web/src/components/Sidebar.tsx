import { Logo } from "./Logo";
import { Icon } from "./Icon";
import { BugReport } from "./BugReport";
import { RowMenu } from "./RowMenu";
import { useTip } from "./Tip";
import { SearchDialog } from "./SearchDialog";
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
  onDeleteProject: (id: string) => void;
  onRename: (id: string, title: string) => Promise<void>;
  onRenameProject: (id: string, name: string) => Promise<void>;
  onOpenProject: (id: string) => void;
  onNewProject: (visibility: "private" | "shared") => void;
  onLogout: () => void;
  onAdmin: () => void;
  onDocs: () => void;
  onTraining: () => void;
  onImport: () => void;
  /** Desktop: hide the sidebar (a button in the main area brings it back). */
  onCollapse?: () => void;
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
export function Sidebar({ me, conversations, projects, selectedId, projectViewId, open, onClose, onSelect, onNew, onNewInProject, onDelete, onDeleteProject, onRename, onRenameProject, onOpenProject, onNewProject, onLogout, onAdmin, onDocs, onTraining, onImport, onCollapse }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [projectDraft, setProjectDraft] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  // Projects whose whole chat list is shown in the sidebar ("View all").
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Sections folded away (Projects, Shared projects, Chats), remembered in this browser.
  const [folded, setFolded] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem("hx.sidebar.folded") ?? "{}") as Record<string, boolean>; } catch { return {}; }
  });
  const toggleSection = (key: string) =>
    setFolded((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try { localStorage.setItem("hx.sidebar.folded", JSON.stringify(next)); } catch { /* private window */ }
      return next;
    });
  const sectionTitle = (key: string, label: string) => (
    <button type="button" className="section-toggle" onClick={() => toggleSection(key)} aria-expanded={!folded[key]} aria-controls={`section-${key}`}>
      <Icon name="chevron" size={13} className={folded[key] ? "" : "rotated"} />
      <span className="section-title">{label}</span>
    </button>
  );
  const { tip, bind } = useTip();
  const [bugOpen, setBugOpen] = useState(false);
  /** Chats shown under a project before "View all". */
  const SHOWN_PER_PROJECT = 4;
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
  const startProjectRename = (p: Project) => {
    setEditingProjectId(p.id);
    setProjectDraft(p.name);
  };
  const commitProjectRename = async () => {
    if (!editingProjectId) return;
    const name = projectDraft.trim().slice(0, 80);
    const id = editingProjectId;
    setEditingProjectId(null);
    if (name) await onRenameProject(id, name);
  };

  const link = (href: string, label: string, icon: "cap" | "book" | "sliders" | "download", go: () => void) => (
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
            {...bind(`${c.title}${inSharedProject && c.createdByName ? ` · started by ${c.createdByName}` : ""}`)}
          >
            <span className="conv-title">{c.title}</span>
          </button>
          <div className="conv-actions">
            <RowMenu
              name={c.title}
              items={[
                { label: "Rename", icon: "pencil", ariaLabel: `Rename: ${c.title}`, onSelect: () => startRename(c) },
                { label: "Delete", icon: "trash", danger: true, ariaLabel: `Delete: ${c.title}`, onSelect: () => { if (window.confirm("Delete this conversation? All of its messages will be removed.")) onDelete(c.id); } },
              ]}
            />
          </div>
        </div>
      )}
    </li>
  );

  const projectGroup = (p: Project) => {
    const chats = conversations.filter((c) => c.projectId === p.id);
    const inShared = p.visibility === "shared";
    const kind = p.visibility === "clinic" ? "Shared with the clinic" : p.visibility === "shared" ? `Shared with ${p.members.length + 1} people` : "Private";
    return (
      <li key={p.id} className={`project-group${p.id === projectViewId ? " active" : ""}`}>
        {editingProjectId === p.id ? (
          <form
            className="rename-form"
            onSubmit={(e) => {
              e.preventDefault();
              void commitProjectRename();
            }}
          >
            <label htmlFor={`rename-project-${p.id}`} className="visually-hidden">
              New project name
            </label>
            <input
              id={`rename-project-${p.id}`}
              autoFocus
              maxLength={80}
              value={projectDraft}
              onChange={(e) => setProjectDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setEditingProjectId(null);
              }}
              onBlur={(e) => {
                if (!(e.relatedTarget instanceof Node && e.currentTarget.form?.contains(e.relatedTarget))) void commitProjectRename();
              }}
            />
            <button type="submit" className="btn btn-small">
              Save
            </button>
            <button type="button" className="btn btn-small" onClick={() => setEditingProjectId(null)}>
              Cancel
            </button>
          </form>
        ) : (
        <div className="project-row">
          <button
            type="button"
            className="conv-select project-select"
            aria-current={p.id === projectViewId ? "true" : undefined}
            onClick={() => onOpenProject(p.id)}
            {...bind(`${p.name} · ${kind} · ${chats.length} ${chats.length === 1 ? "chat" : "chats"}`)}
          >
            <Icon name="folder" size={15} className="conv-icon" />
            <span className="conv-title">{p.name}</span>
          </button>
          <button type="button" className="icon-btn row-action" onClick={() => onNewInProject(p.id)} aria-label={`New chat in ${p.name}`} title="New chat in this project">
            <Icon name="plus" size={15} />
          </button>
          <span className="row-action">
            <RowMenu
              name={p.name}
              items={[
                { label: "Edit details", icon: "sliders", ariaLabel: `Edit project: ${p.name}`, onSelect: () => onOpenProject(p.id) },
                ...(p.canEdit ? [{ label: "Rename", icon: "pencil" as const, ariaLabel: `Rename project: ${p.name}`, onSelect: () => startProjectRename(p) }] : []),
                { label: "New chat", icon: "plus", ariaLabel: `Start a chat in ${p.name}`, onSelect: () => onNewInProject(p.id) },
                ...(p.canManage ? [{ label: "Delete", icon: "trash" as const, danger: true, ariaLabel: `Delete project: ${p.name}`, onSelect: () => { if (window.confirm(`Delete the project "${p.name}"? Its chats stay, outside the project.`)) onDeleteProject(p.id); } }] : []),
              ]}
            />
          </span>
        </div>
        )}
        <ul className="project-chats" aria-label={`Chats in ${p.name}`}>
          {chats.length === 0 && <li className="muted small project-empty">No chats yet</li>}
          {(expanded[p.id] ? chats : chats.slice(0, SHOWN_PER_PROJECT)).map((c) => conversationItem(c, inShared))}
          {chats.length > SHOWN_PER_PROJECT && (
            <li>
              <button type="button" className="conv-select view-all" aria-expanded={!!expanded[p.id]} onClick={() => setExpanded((prev) => ({ ...prev, [p.id]: !prev[p.id] }))}>
                {expanded[p.id] ? "Show fewer" : `View all (${chats.length})`}
              </button>
            </li>
          )}
        </ul>
      </li>
    );
  };

  return (
    <aside id="sidebar" className={`sidebar${open ? " open" : ""}`} aria-label="Conversations">
      <div className="sidebar-head">
        <Logo />
        <span className="sidebar-head-actions">
          <button type="button" className={`icon-btn${searchOpen ? " active" : ""}`} onClick={() => setSearchOpen(true)} aria-label="Search chats" aria-expanded={searchOpen} title="Search chats">
            <Icon name="search" size={17} />
          </button>
          {onCollapse && (
            <button type="button" className="icon-btn only-desktop" onClick={onCollapse} aria-label="Hide sidebar" title="Hide sidebar">
              <Icon name="panel" size={17} />
            </button>
          )}
          <button type="button" className="icon-btn only-mobile" onClick={onClose} aria-label="Close panel">
            <Icon name="close" />
          </button>
        </span>
      </div>
      {searchOpen && <SearchDialog conversations={conversations} projects={projects} onSelect={onSelect} onOpenProject={onOpenProject} onClose={() => setSearchOpen(false)} />}

      <nav className="side-nav" aria-label="Main">
        <button type="button" className="side-link side-link-new" onClick={onNew}>
          <Icon name="plus" size={16} />
          <span>New chat</span>
        </button>
        {isAdmin && link("/admin", "Administration", "sliders", onAdmin)}
      </nav>

      <div className="sidebar-scroll">
        <nav className="project-list" aria-label="Projects">
          <div className="section-head">
            {sectionTitle("projects", "Projects")}
            <button type="button" className="icon-btn" onClick={() => onNewProject("private")} aria-label="New project" title="New project">
              <Icon name="plus" size={15} />
            </button>
          </div>
          <div id="section-projects" hidden={!!folded["projects"]}>
            {mine.length === 0 && <p className="muted small side-empty">No projects yet. A project gives every conversation in it the same instructions and files.</p>}
            <ul>{mine.map(projectGroup)}</ul>
          </div>
        </nav>

        <nav className="project-list shared-project-list" aria-label="Shared projects">
          <div className="section-head">
            {sectionTitle("shared", "Shared projects")}
            <button type="button" className="icon-btn" onClick={() => onNewProject("shared")} aria-label="New shared project" title="New shared project">
              <Icon name="plus" size={15} />
            </button>
          </div>
          <div id="section-shared" hidden={!!folded["shared"]}>
            {shared.length === 0 && <p className="muted small side-empty">No shared projects yet. In a shared project, the people you choose see and continue the same chats.</p>}
            <ul>{shared.map(projectGroup)}</ul>
          </div>
        </nav>

        <nav className="conv-list" aria-label="Conversation list">
          <div className="section-head">{sectionTitle("chats", "Chats")}</div>
          <div id="section-chats" hidden={!!folded["chats"]}>
            {loose.length === 0 && <p className="muted small side-empty">{conversations.length === 0 ? "You don't have any conversations yet." : "All your conversations are in projects."}</p>}
            <ul>{loose.map((c) => conversationItem(c))}</ul>
          </div>
        </nav>
      </div>

      <div className="sidebar-foot">
        {bugOpen && <BugReport open onClose={() => setBugOpen(false)} />}
        <div className="user-row" title={me.user.email}>
          <span className="avatar" aria-hidden="true">
            {initials(me.user.name)}
          </span>
          <span className="user-line">
            <span className="user-name">{me.user.name}</span>
            <span className="muted small">{isAdmin ? "Administrator" : "Staff"}</span>
          </span>
          <RowMenu
            name="settings"
            label="Settings"
            icon="gear"
            items={[
              { label: "Training", icon: "cap", onSelect: onTraining },
              { label: "Documentation", icon: "book", onSelect: onDocs },
              ...(isAdmin ? [{ label: "Import from Claude", icon: "download" as const, onSelect: onImport }] : []),
              { label: "Report a bug", icon: "bug", onSelect: () => setBugOpen(true) },
              { label: "Sign out", icon: "logout", onSelect: onLogout },
            ]}
          />
        </div>
      </div>
      {tip}
    </aside>
  );
}
