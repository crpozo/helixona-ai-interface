import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Conversation, Project } from "../lib/types";
import { matchesQuery } from "../lib/search";
import { Icon } from "./Icon";

interface Props {
  conversations: Conversation[];
  projects: Project[];
  onSelect: (id: string) => void;
  onOpenProject: (id: string) => void;
  onClose: () => void;
}

type Row = { kind: "project"; id: string; title: string; sub: string } | { kind: "chat"; id: string; title: string; sub: string; when: string };

/** "Just now", "Today", "Yesterday", "Mon 3 Oct", or the date, like the recents in Claude. */
export function whenLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const ms = now.getTime() - d.getTime();
  if (ms < 60 * 60_000) return "Past hour";
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString("en-US", { weekday: "long" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

/**
 * The search as Claude does it: a box over the page with the recent chats listed at once, narrowed
 * as you type across chats and projects; arrows and Enter pick, Escape closes.
 */
export function SearchDialog({ conversations, projects, onSelect, onOpenProject, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const q = query.trim();

  const rows = useMemo<Row[]>(() => {
    const byName = new Map(projects.map((p) => [p.id, p.name]));
    const chats = [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const projRows: Row[] = (q ? projects.filter((p) => matchesQuery(p.name, q)) : []).map((p) => ({ kind: "project", id: p.id, title: p.name, sub: "Project" }));
    const chatRows: Row[] = (q ? chats.filter((c) => matchesQuery(c.title, q)) : chats.slice(0, 30)).map((c) => ({ kind: "chat", id: c.id, title: c.title, sub: c.projectId ? byName.get(c.projectId) ?? "" : "", when: whenLabel(c.updatedAt) }));
    return [...projRows, ...chatRows];
  }, [conversations, projects, q]);

  useEffect(() => {
    input.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  useEffect(() => setCursor(0), [q]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const pick = (r: Row) => {
    onClose();
    if (r.kind === "project") onOpenProject(r.id);
    else onSelect(r.id);
  };

  return createPortal(
    <div className="search-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="search-dialog" role="dialog" aria-modal="true" aria-label="Search chats and projects">
        <div className="search-box">
          <Icon name="search" size={18} className="conv-icon" />
          <label htmlFor="side-search" className="visually-hidden">
            Search chats
          </label>
          <input
            id="side-search"
            ref={input}
            type="search"
            placeholder="Search chats and projects"
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(rows.length - 1, c + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
              else if (e.key === "Enter" && rows[cursor]) { e.preventDefault(); pick(rows[cursor]!); }
            }}
          />
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close search">
            <Icon name="close" size={16} />
          </button>
        </div>
        <ul className="search-results" ref={list} role="listbox" aria-label={q ? "Matches" : "Recent chats"}>
          {rows.length === 0 && (
            <li className="search-empty">
              <span className="section-title">{q ? "No matches" : "No chats yet"}</span>
            </li>
          )}
          {rows.map((r, i) => (
            <li key={`${r.kind}-${r.id}`} data-i={i} role="option" aria-selected={i === cursor} className={`search-row${i === cursor ? " active" : ""}`} onMouseEnter={() => setCursor(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(r)}>
              <Icon name={r.kind === "project" ? "folder" : "chat"} size={16} className="conv-icon" />
              <span className="conv-title">
                {r.title}
                {r.sub && <span className="search-sub">{r.sub}</span>}
              </span>
              {r.kind === "chat" && <span className="search-when">{r.when}</span>}
              {i === cursor && <span className="search-enter" aria-hidden="true">↵</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
