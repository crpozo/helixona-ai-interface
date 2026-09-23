import { useEffect, useState } from "react";
import { ApiError, addProjectMember, listUsers, removeProjectMember } from "../lib/api";
import type { DirectoryEntry, Project, ProjectMember } from "../lib/types";

interface Props {
  project: Project;
  /** The signed-in user, named "You" in the list. */
  meId: string;
  onUpdated: (project: Project) => void;
}

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : "Something went wrong. Please try again.";
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1]![0] ?? "" : "")).toUpperCase() || "?";
}

/**
 * Who takes part in the project. For a shared project: the owner and the members, with a picker over
 * the clinic's directory for the owner (or an administrator). Other kinds get a line saying who sees
 * the project and how to share it.
 */
export function ProjectMembers({ project, meId, onUpdated }: Props) {
  const [picking, setPicking] = useState(false);
  const [people, setPeople] = useState<DirectoryEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    setPicking(false);
    setQuery("");
    setError(null);
  }, [project.id]);

  const openPicker = async () => {
    setPicking(true);
    setError(null);
    if (people) return;
    try {
      setPeople(await listUsers());
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const add = async (u: DirectoryEntry) => {
    setBusy(u.id);
    setError(null);
    try {
      onUpdated(await addProjectMember(project.id, u.id));
      setQuery("");
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (m: ProjectMember) => {
    if (!window.confirm(`Remove ${m.name} from this project? They will no longer see its chats.`)) return;
    setBusy(m.id);
    setError(null);
    try {
      onUpdated(await removeProjectMember(project.id, m.id));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  if (project.visibility !== "shared") {
    return (
      <section className="side-card" aria-labelledby="proj-sharing-h">
        <div className="side-card-head">
          <h2 id="proj-sharing-h">Sharing</h2>
        </div>
        <p className="muted small">
          {project.visibility === "clinic"
            ? "Everyone in the clinic can use this project's instructions and files. Each person's chats stay their own."
            : project.canManage
              ? "Only you can see this project. To work on it with colleagues, choose “Shared with chosen people” under Settings: everyone you add sees and continues the same chats."
              : "Only the project owner can see this project."}
        </p>
      </section>
    );
  }

  const inProject = new Set([project.ownerId, ...project.members.map((m) => m.id)]);
  const q = query.trim().toLowerCase();
  const candidates = (people ?? []).filter((u) => !inProject.has(u.id) && (!q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))).slice(0, 8);
  const ownerLabel = project.ownerId === meId ? "You" : project.ownerName || "Owner";

  return (
    <section className="side-card" aria-labelledby="proj-members-h">
      <div className="side-card-head">
        <h2 id="proj-members-h">Members</h2>
        {project.canManage && !picking && (
          <button type="button" className="btn btn-small" onClick={() => void openPicker()}>
            Add people
          </button>
        )}
      </div>
      <p className="muted small">Everyone here sees and can continue every chat in this project.</p>
      <ul className="member-list" aria-label="Members">
        <li className="member-row">
          <span className="avatar" aria-hidden="true">
            {initials(project.ownerName || ownerLabel)}
          </span>
          <span className="member-text">
            <span className="member-name">
              {ownerLabel} <span className="muted">· owner</span>
            </span>
          </span>
        </li>
        {project.members.map((m) => (
          <li key={m.id} className="member-row">
            <span className="avatar" aria-hidden="true">
              {initials(m.name)}
            </span>
            <span className="member-text">
              <span className="member-name">{m.id === meId ? `${m.name} (you)` : m.name}</span>
              <span className="member-email">{m.email}</span>
            </span>
            {project.canManage && (
              <button type="button" className="icon-btn" disabled={busy === m.id} onClick={() => void remove(m)} aria-label={`Remove ${m.name}`} title="Remove from the project">
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      {picking && (
        <div className="member-picker">
          <label htmlFor="member-search" className="visually-hidden">
            Find a colleague
          </label>
          <input id="member-search" type="search" placeholder="Search by name or email" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus autoComplete="off" />
          {people === null ? (
            <p className="muted small">Loading the directory…</p>
          ) : candidates.length === 0 ? (
            <p className="muted small">{q ? "No one matches." : "Everyone in the clinic is already in this project."}</p>
          ) : (
            <ul className="member-candidates">
              {candidates.map((u) => (
                <li key={u.id} className="member-row">
                  <span className="avatar" aria-hidden="true">
                    {initials(u.name)}
                  </span>
                  <span className="member-text">
                    <span className="member-name">{u.name}</span>
                    <span className="member-email">{u.email}</span>
                  </span>
                  <button type="button" className="btn btn-small" disabled={busy === u.id} onClick={() => void add(u)} aria-label={`Add ${u.name}`}>
                    Add
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="row gap wrap side-actions">
            <button type="button" className="btn btn-small" onClick={() => setPicking(false)}>
              Done
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
