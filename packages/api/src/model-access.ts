import { modelsForRole, type Catalog, type CatalogModel, type Role } from "@helixona/core";
import type { Deps } from "./deps.js";

/**
 * Which models each person may use. The policy comes from configuration (MODEL_ACCESS, JSON) and an
 * administrator can override it per person from the Administration page; overrides live in the
 * settings table under `model-access`, keyed by lower-case email (no PHI). Resolution, per person:
 * administrator override → policy entry for the email → every model for administrators → the policy
 * default. Whatever the result, a model the person's role does not have is never offered.
 */
export interface ModelAccessPolicy {
  /** Aliases staff get unless named below; null = every model their role has (no policy configured). */
  default: string[] | null;
  /** Per email (lower case). */
  users: Record<string, string[]>;
}

export interface ModelAccessOverrides { users: Record<string, string[]> }

export const MODEL_ACCESS_SETTING = "model-access";
const NO_POLICY: ModelAccessPolicy = { default: null, users: {} };

export function parseModelAccess(json: string | undefined | null): ModelAccessPolicy {
  if (!json || !json.trim()) return NO_POLICY;
  const raw = JSON.parse(json) as Partial<ModelAccessPolicy>;
  const users: Record<string, string[]> = {};
  for (const [email, aliases] of Object.entries(raw.users ?? {})) users[email.trim().toLowerCase()] = [...aliases];
  return { default: Array.isArray(raw.default) ? [...raw.default] : null, users };
}

const parsed = new Map<string, ModelAccessPolicy>();
/** The configured policy (MODEL_ACCESS), parsed once per value. */
export function policyOf(deps: Deps): ModelAccessPolicy {
  const key = deps.config.MODEL_ACCESS ?? "";
  let p = parsed.get(key);
  if (!p) parsed.set(key, (p = parseModelAccess(key)));
  return p;
}

export type ModelAccessSource = "override" | "policy" | "admin" | "default";

export interface ResolvedAccess { aliases: string[]; source: ModelAccessSource }

/** The aliases a person may use, before the role filter. */
export function resolveAccess(policy: ModelAccessPolicy, overrides: ModelAccessOverrides | null, email: string, roles: readonly Role[], catalog: Catalog): ResolvedAccess {
  const key = email.trim().toLowerCase();
  const override = overrides?.users[key];
  if (override) return { aliases: override, source: "override" };
  const named = policy.users[key];
  if (named) return { aliases: named, source: "policy" };
  const all = catalog.models.map((m) => m.alias);
  if (roles.includes("admin")) return { aliases: all, source: "admin" };
  return { aliases: policy.default ?? all, source: "default" };
}

export async function loadOverrides(deps: Deps): Promise<ModelAccessOverrides | null> {
  return deps.repos.settings.get<ModelAccessOverrides>(MODEL_ACCESS_SETTING);
}

/** The catalog models this session may start or switch a conversation to, in catalog order. */
export async function allowedModels(deps: Deps, s: { email: string; roles: Role[] }): Promise<CatalogModel[]> {
  const { aliases } = resolveAccess(policyOf(deps), await loadOverrides(deps), s.email, s.roles, deps.catalog);
  const byRole = modelsForRole(deps.catalog, s.roles);
  return byRole.filter((m) => aliases.includes(m.alias));
}

/** The model a new conversation starts with: the catalog default when allowed, else the most capable allowed one. */
export function defaultModelFor(catalog: Catalog, allowed: CatalogModel[]): CatalogModel | undefined {
  return allowed.find((m) => m.alias === catalog.defaultAlias) ?? [...allowed].sort((a, b) => b.costFactor - a.costFactor)[0];
}
