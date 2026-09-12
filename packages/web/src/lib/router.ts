import { useCallback, useEffect, useState } from "react";

export type Route = "/login" | "/" | "/admin";

const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

export function normalizeRoute(pathname: string): Route {
  if (pathname === "/login" || pathname.startsWith("/login/")) return "/login";
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return "/admin";
  return "/";
}

/** Navega sin recargar. Nunca ponemos datos (ids, títulos) en la URL. */
export function navigate(to: Route, opts: { replace?: boolean } = {}) {
  if (typeof window === "undefined") return;
  if (window.location.pathname === to) return;
  if (opts.replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  notify();
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() =>
    typeof window === "undefined" ? "/" : normalizeRoute(window.location.pathname),
  );
  const update = useCallback(() => setRoute(normalizeRoute(window.location.pathname)), []);
  useEffect(() => {
    listeners.add(update);
    window.addEventListener("popstate", update);
    return () => {
      listeners.delete(update);
      window.removeEventListener("popstate", update);
    };
  }, [update]);
  return route;
}
