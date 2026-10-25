import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon";

export interface RowMenuItem {
  label: string;
  icon: IconName;
  onSelect: () => void;
  /** Destructive: shown in red, last. */
  danger?: boolean;
  /** Accessible name when it should differ from the label (tests and screen readers name the row). */
  ariaLabel?: string;
}

interface Props {
  /** What the menu is for ("Options for Cambridge"). */
  name: string;
  items: RowMenuItem[];
  /** The trigger's accessible name when it is not "Options for <name>" (the settings gear). */
  label?: string;
  icon?: IconName;
}

/**
 * The three-dot menu of a row, like Claude's: a small popover under the button with the row's
 * actions. It closes on a choice, on Escape, or on a click anywhere else.
 */
export function RowMenu({ name, items, label, icon = "dots" }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    // Below the button, aligned to its right edge, kept inside the window.
    const width = 200;
    const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
    // Below the button, or above it when there is no room below (the settings gear at the foot).
    const below = r.bottom + 4 + items.length * 40 + 16 < window.innerHeight;
    setPos({ top: below ? r.bottom + 4 : Math.max(8, r.top - 4 - items.length * 40 - 16), left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (menu.current?.contains(e.target as Node) || btn.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); btn.current?.focus(); }
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
      <button ref={btn} type="button" className={`icon-btn row-menu-btn${open ? " active" : ""}`} aria-label={label ?? `Options for ${name}`} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name={icon} size={icon === "dots" ? 16 : 18} />
      </button>
      {open &&
        pos &&
        createPortal(
          <div ref={menu} className="row-menu" role="menu" aria-label={label ?? `Options for ${name}`} style={{ top: pos.top, left: pos.left }}>
            {items.map((it, i) => (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                className={`row-menu-item${it.danger ? " danger" : ""}${it.danger && i > 0 && !items[i - 1]!.danger ? " first-danger" : ""}`}
                aria-label={it.ariaLabel ?? it.label}
                onClick={() => {
                  setOpen(false);
                  it.onSelect();
                }}
              >
                <Icon name={it.icon} size={15} />
                <span>{it.label}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
