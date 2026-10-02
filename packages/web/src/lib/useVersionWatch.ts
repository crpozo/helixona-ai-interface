import { useEffect, useState } from "react";
import { getHealth } from "./api";

/** How often a page that stays open asks whether a newer version of the assistant is running. */
const CHECK_EVERY_MS = 5 * 60_000;

/**
 * A page left open after a deploy keeps running the old code until it is reloaded, which looks
 * like features that "do not work". The server reports the version it runs; when it changes from
 * the one this page started with, the caller shows a notice to reload. "dev" (no version) is ignored.
 */
export function useVersionWatch(enabled: boolean): string | null {
  const [newVersion, setNewVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let first: string | null = null;
    let alive = true;
    const check = async () => {
      try {
        const { version } = await getHealth();
        if (!alive || !version || version === "dev") return;
        if (first === null) first = version;
        else if (version !== first) setNewVersion(version);
      } catch {
        // offline or signing out: nothing to say
      }
    };
    void check();
    const timer = setInterval(() => void check(), CHECK_EVERY_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [enabled]);
  return newVersion;
}
