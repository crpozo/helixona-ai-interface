import { Logo } from "./Logo";
import { useState } from "react";
import type { Conversation, Me } from "../lib/types";
import { modelLabel } from "../lib/models";

interface Props {
  me: Me;
  conversations: Conversation[];
  selectedId: string | null;
  open: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => Promise<void>;
  onLogout: () => void;
  onAdmin: () => void;
}

export function Sidebar({ me, conversations, selectedId, open, onClose, onSelect, onNew, onDelete, onRename, onLogout, onAdmin }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const isAdmin = me.user.roles.includes("admin");

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
    <aside id="sidebar" className={`sidebar${open ? " open" : ""}`} aria-label="Conversaciones">
      <div className="sidebar-head">
        <Logo />
        <button type="button" className="btn btn-icon only-mobile" onClick={onClose} aria-label="Cerrar panel">
          ×
        </button>
      </div>

      <button type="button" className="btn btn-primary block" onClick={onNew}>
        Nueva conversación
      </button>

      <nav className="conv-list" aria-label="Lista de conversaciones">
        {conversations.length === 0 && <p className="muted small">Aún no tienes conversaciones.</p>}
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
                    Nuevo título
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
                    Guardar
                  </button>
                  <button type="button" className="btn btn-small" onClick={() => setEditingId(null)}>
                    Cancelar
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
                    <span className="conv-meta">{modelLabel(me.catalog.models, c.modelId)}</span>
                  </button>
                  <div className="conv-actions">
                    <button type="button" className="btn btn-icon" onClick={() => startRename(c)} aria-label={`Renombrar: ${c.title}`} title="Renombrar">
                      ✎
                    </button>
                    <button
                      type="button"
                      className="btn btn-icon"
                      onClick={() => {
                        if (window.confirm("¿Borrar esta conversación? Se eliminarán todos sus mensajes.")) onDelete(c.id);
                      }}
                      aria-label={`Borrar: ${c.title}`}
                      title="Borrar"
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
          <span className="muted small">{isAdmin ? "Administración" : "Personal"}</span>
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
            Administración
          </a>
        )}
        <button type="button" className="btn block" onClick={onLogout}>
          Cerrar sesión
        </button>
      </div>
    </aside>
  );
}
