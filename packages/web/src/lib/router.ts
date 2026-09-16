import { useCallback, useEffect, useState } from "react";

export type Route = "/login" | "/" | "/admin" | "/documentation";
/** Paths `navigate` accepts: a route, or one document inside the documentation. */
export type Path = Route | `/documentation/${string}`;

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
  if (pathname === "/documentation" || pathname.startsWith("/documentation/")) return "/documentation";
  return "/";
}

/** Slug of the document in `/documentation/<slug>`; null on the index or on any other route. */
export function documentSlug(pathname: string): string | null {
  const m = /^\/documentation\/([^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1] ?? "");
  } catch {
    return null;
  }
}

/** Navega sin recargar. Nunca ponemos datos (ids, títulos) en la URL; solo rutas y el slug de un documento. */
export function navigate(to: Path, opts: { replace?: boolean } = {}) {
  if (typeof window === "undefined") return;
  if (currentPath() === to) return;
  const target = HASH_MODE ? `#${to}` : to;
  if (opts.replace) window.history.replaceState(null, "", target);
  else window.history.pushState(null, "", target);
  notify();
}

function useLocation<T>(select: (path: string) => T): T {
  const [value, setValue] = useState<T>(() => select(currentPath()));
  const update = useCallback(() => setValue(select(currentPath())), [select]);
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
  return value;
}

const identity = (path: string) => path;

/** Route of the current URL, outside React (for handlers that must not navigate away from public pages). */
export function currentRoute(): Route {
  return normalizeRoute(currentPath());
}

export function useRoute(): Route {
  return useLocation(normalizeRoute);
}

/** The raw current path (for pages that read a slug out of it). */
export function usePath(): string {
  return useLocation(identity);
}
