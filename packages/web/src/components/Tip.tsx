import { useCallback, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";

interface TipState {
  text: string;
  top: number;
  left: number;
}

/**
 * A tooltip for names that do not fit their row: it appears on hover only when the text is cut
 * off, under the row, so the full title is one glance away (like Claude's sidebar).
 */
export function useTip(): { tip: JSX.Element | null; bind: (text: string) => { onMouseEnter: (e: MouseEvent<HTMLElement>) => void; onMouseLeave: () => void } } {
  const [state, setState] = useState<TipState | null>(null);
  const bind = useCallback(
    (text: string) => ({
      onMouseEnter: (e: MouseEvent<HTMLElement>) => {
        const el = e.currentTarget.querySelector<HTMLElement>(".conv-title") ?? e.currentTarget;
        if (el.scrollWidth <= el.clientWidth + 1) return;
        const r = e.currentTarget.getBoundingClientRect();
        setState({ text, top: r.bottom + 6, left: Math.max(8, Math.min(r.left + 8, window.innerWidth - 328)) });
      },
      onMouseLeave: () => setState(null),
    }),
    [],
  );
  const tip = state ? createPortal(<div className="tip" role="tooltip" style={{ top: state.top, left: state.left }}>{state.text}</div>, document.body) : null;
  return { tip, bind };
}
