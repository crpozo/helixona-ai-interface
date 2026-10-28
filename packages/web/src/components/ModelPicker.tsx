import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CatalogModel } from "../lib/types";
import { Icon } from "./Icon";

interface Props {
  id: string;
  label: string;
  models: CatalogModel[];
  value: string;
  onChange: (alias: string) => void;
  disabled?: boolean;
  title?: string;
}

/**
 * The model picker, like Claude's: a quiet button with the model's name, and a list with each model's
 * name and a short line on what it is for (which also says whether it is cheap or expensive).
 */
export function ModelPicker({ id, label, models, value, onChange, disabled, title }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const current = models.find((m) => m.alias === value) ?? models[0];

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const width = 320;
    const height = models.length * 56 + 16;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    // Above the button when it sits at the foot of the page (the composer), below otherwise.
    const up = r.bottom + 4 + height > window.innerHeight;
    setPos({ top: up ? Math.max(8, r.top - 4 - height) : r.bottom + 4, left, up });
  }, [open, models.length]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (menu.current?.contains(e.target as Node) || btn.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", () => setOpen(false), { once: true });
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  return (
    <>
      <button ref={btn} id={id} type="button" className={`model-switch${open ? " open" : ""}`} aria-label={`${label}: ${current?.label ?? ""}`} aria-haspopup="listbox" aria-expanded={open} disabled={disabled} title={title} onClick={() => setOpen((v) => !v)}>
        <span>{current?.label}</span>
        <Icon name="chevron" size={13} className="rotated" />
      </button>
      {open &&
        pos &&
        createPortal(
          <div ref={menu} className="row-menu model-menu" role="listbox" aria-label={label} style={{ top: pos.top, left: pos.left, minWidth: 320 }}>
            {models.map((m) => (
              <button
                key={m.alias}
                type="button"
                role="option"
                aria-selected={m.alias === value}
                className={`model-option${m.alias === value ? " selected" : ""}`}
                onClick={() => {
                  setOpen(false);
                  if (m.alias !== value) onChange(m.alias);
                }}
              >
                <span className="model-option-text">
                  <span className="model-option-name">{m.label}</span>
                  <span className="model-option-desc">{m.description}</span>
                </span>
                {m.alias === value && <span className="model-option-check" aria-hidden="true">✓</span>}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
