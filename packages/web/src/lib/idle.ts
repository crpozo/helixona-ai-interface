import { useEffect, useRef, useState } from "react";
import { setActivityHandler } from "./api";

export const WARN_BEFORE_SECONDS = 120;

interface Options {
  enabled: boolean;
  timeoutSeconds: number;
  onExpire: () => void;
}

/**
 * Temporizador de inactividad. Cualquier tecla, click, toque o fetch reinicia el contador.
 * Devuelve los segundos restantes cuando quedan menos de `WARN_BEFORE_SECONDS`, si no `null`.
 */
export function useIdleTimeout({ enabled, timeoutSeconds, onExpire }: Options): {
  secondsLeft: number | null;
  reset: () => void;
} {
  const lastActivity = useRef<number>(Date.now());
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const expireRef = useRef(onExpire);
  expireRef.current = onExpire;
  const firedRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      setSecondsLeft(null);
      setActivityHandler(null);
      return;
    }
    lastActivity.current = Date.now();
    firedRef.current = false;

    const touch = () => {
      lastActivity.current = Date.now();
    };
    const events: (keyof WindowEventMap)[] = ["keydown", "pointerdown", "touchstart", "wheel"];
    for (const e of events) window.addEventListener(e, touch, { passive: true });
    setActivityHandler(touch);

    const tick = () => {
      const elapsed = (Date.now() - lastActivity.current) / 1000;
      const left = Math.ceil(timeoutSeconds - elapsed);
      if (left <= 0) {
        if (!firedRef.current) {
          firedRef.current = true;
          setSecondsLeft(0);
          expireRef.current();
        }
        return;
      }
      setSecondsLeft(left <= WARN_BEFORE_SECONDS ? left : null);
    };
    const interval = window.setInterval(tick, 1000);
    tick();

    return () => {
      window.clearInterval(interval);
      for (const e of events) window.removeEventListener(e, touch);
      setActivityHandler(null);
    };
  }, [enabled, timeoutSeconds]);

  return {
    secondsLeft,
    reset: () => {
      lastActivity.current = Date.now();
      setSecondsLeft(null);
    },
  };
}
