import { useCallback, useEffect, useState } from "react";

export type Route = "/login" | "/" | "/admin";

const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

/** En la vista previa publicada (modo demo) la ruta vive en el hash para no alterar la URL del host. */
const HASH_MODE = import.meta.env.MODE === "demo";

function currentPath(): string {
  if (typeof window === "undefined") return "/";
  return HASH_MODE ? window.location.hash.replace(/^#/, "") || "/" : window.location.pathname;
}

export function normalizeRoute(pathname: string): Route {
  if (pathname === "/login" || pathname.startsWith("/login/")) return "/login";
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return "/admin";
  return "/";
}

/** Navega sin recargar. Nunca ponemos datos (ids, títulos) en la URL. */
export function navigate(to: Route, opts: { replace?: boolean } = {}) {
  if (typeof window === "undefined") return;
  if (currentPath() === to) return;
  const target = HASH_MODE ? `#${to}` : to;
  if (opts.replace) window.history.replaceState(null, "", target);
  else window.history.pushState(null, "", target);
  notify();
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() =>
    typeof window === "undefined" ? "/" : normalizeRoute(currentPath()),
  );
  const update = useCallback(() => setRoute(normalizeRoute(currentPath())), []);
  useEffect(() => {
    listeners.add(update);
    window.addEventListener("popstate", update);
    window.addEventListener("hashchange", update);
    return () => {
      listeners.delete(update);
      window.removeEventListener("popstate", update);
      window.removeEventListener("hashchange", update);
    };
  }, [update]);
  return route;
}
