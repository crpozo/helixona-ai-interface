import type { FastifyInstance } from "fastify";
import type { Deps } from "../deps.js";
import { requireAuth } from "../app.js";

/**
 * The clinic's accounts, for choosing whom to share a project with. Names and emails only (no roles,
 * no status): what a colleague needs to find the right person.
 */
export function registerUserRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/api/users", { preHandler: requireAuth() }, async () => {
    const items = (await deps.directory.list())
      .filter((u) => u.enabled)
      .map(({ id, name, email }) => ({ id, name, email }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email));
    return { items };
  });
}
