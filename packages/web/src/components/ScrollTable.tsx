import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A wide table that scrolls sideways: the scrollbar is always visible, a shadow marks the hidden
 * part, and a line above says so while there is more to the right (nothing when everything fits).
 */
export function ScrollTable({ children, stickyActions = false }: { children: ReactNode; stickyActions?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState<{ left: boolean; right: boolean } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const overflow = el.scrollWidth - el.clientWidth > 2;
      setMore(overflow ? { left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 } : null);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const c of Array.from(el.children)) ro.observe(c);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [children]);
  return (
    <div className={`table-scroll${stickyActions ? " sticky-actions" : ""}`}>
      {more && (
        <p className="table-scroll-hint muted small" role="status">
          {more.right ? "The table is wider than the window: scroll sideways to see every column." : "You are at the end of the table."}
          {stickyActions && more.right ? " The buttons stay on the right." : ""}
        </p>
      )}
      <div className={`table-scroll-body${more?.right ? " more-right" : ""}${more?.left ? " more-left" : ""}`}>
        <div className="table-wrap" ref={ref} tabIndex={0}>
          {children}
        </div>
      </div>
    </div>
  );
}
