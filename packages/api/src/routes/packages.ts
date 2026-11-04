import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AttachmentMeta } from "@helixona/core";
import type { Deps } from "../deps.js";
import { apiError, audit, requireAuth } from "../app.js";
import { locateConversation } from "./conversations.js";
import { buildPackage, canPackage, loadManifest, packageKey, packageZip, publicManifest, type PackageCandidate } from "../attachments/packages.js";
import { safeName } from "../attachments/policy.js";

/**
 * Packages built in a conversation: the manifest for the card, the PDF and the ZIP to download, and a
 * rebuild with other contents. The documents a package may hold are the conversation's attachments and
 * the project's files, so a person who can read the conversation can download the package.
 */
export function registerPackageRoutes(app: FastifyInstance, deps: Deps): void {
  const Params = z.object({ id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/), pid: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/) });

  async function locate(req: FastifyRequest, reply: FastifyReply) {
    const params = Params.safeParse(req.params);
    if (!params.success) return apiError(reply, 400, "bad_request", "Invalid request"), null;
    if (!deps.attachments) return apiError(reply, 400, "attachments_disabled", "File storage is not enabled on this server"), null;
    const l = await locateConversation(deps, req.session!, params.data.id);
    if (!l) return apiError(reply, 404, "not_found", "Conversation not found"), null;
    const manifest = await loadManifest(deps.attachments, params.data.id, params.data.pid);
    if (!manifest) return apiError(reply, 404, "not_found", "Package not found"), null;
    return { ...params.data, l, manifest };
  }

  /**
   * Everything the package may hold now: what it could hold when it was built (the turn's own
   * attachments may not be saved yet when the person edits right away), plus the conversation's
   * attachments and the project's files since.
   */
  async function candidatesOf(conversationId: string, known: PackageCandidate[], projectKnowledge: AttachmentMeta[]): Promise<PackageCandidate[]> {
    const messages = await deps.repos.messages.list(conversationId);
    const seen = new Set<string>();
    const out: PackageCandidate[] = [];
    const add = (m: AttachmentMeta, source: "chat" | "project") => {
      if (seen.has(m.id) || !canPackage(m.contentType)) return;
      seen.add(m.id);
      out.push({ ...m, source });
    };
    for (const c of known) add(c, c.source);
    for (const m of projectKnowledge) add(m, "project");
    for (const m of messages.filter((m) => m.role === "user").flatMap((m) => m.attachments ?? [])) add(m, "chat");
    return out;
  }

  app.get("/api/conversations/:id/packages/:pid", { preHandler: requireAuth() }, async (req, reply) => {
    const x = await locate(req, reply);
    if (!x) return;
    return publicManifest(x.manifest);
  });

  app.get("/api/conversations/:id/packages/:pid/pdf", { preHandler: requireAuth() }, async (req, reply) => {
    const x = await locate(req, reply);
    if (!x) return;
    const bytes = await deps.attachments!.get(packageKey(x.id, x.pid, "package.pdf"));
    await audit(deps, req, { action: "package_download", conversationId: x.id, meta: { format: "pdf", documents: x.manifest.items.filter((i) => i.included).length - 1, pages: x.manifest.pages, bytes: bytes.length } });
    return reply
      .header("content-type", "application/pdf")
      .header("content-disposition", `attachment; filename="${safeName(x.manifest.title)}.pdf"`)
      .header("cache-control", "private, no-store")
      .send(bytes);
  });

  app.get("/api/conversations/:id/packages/:pid/zip", { preHandler: requireAuth() }, async (req, reply) => {
    const x = await locate(req, reply);
    if (!x) return;
    const candidates = await candidatesOf(x.id, x.manifest.candidates ?? [], x.l.project?.knowledge ?? []);
    const bytes = await packageZip(deps.attachments!, x.id, x.manifest, new Map(candidates.map((c) => [c.id, c])));
    await audit(deps, req, { action: "package_download", conversationId: x.id, meta: { format: "zip", documents: x.manifest.items.filter((i) => i.included).length - 1, bytes: bytes.length } });
    return reply
      .header("content-type", "application/zip")
      .header("content-disposition", `attachment; filename="${safeName(x.manifest.title)}.zip"`)
      .header("cache-control", "private, no-store")
      .send(bytes);
  });

  // Other contents, same summary: the ids of the documents to include, in order (the summary always goes first).
  app.post("/api/conversations/:id/packages/:pid", { preHandler: requireAuth() }, async (req, reply) => {
    const x = await locate(req, reply);
    if (!x) return;
    const body = z.object({ documents: z.array(z.string().min(1).max(64)).max(40) }).safeParse(req.body);
    if (!body.success) return apiError(reply, 400, "bad_request", "Invalid request");
    const candidates = await candidatesOf(x.id, x.manifest.candidates ?? [], x.l.project?.knowledge ?? []);
    const ids = new Set(candidates.map((c) => c.id));
    const selection = body.data.documents.filter((d) => ids.has(d));
    const now = deps.now ?? (() => new Date());
    const manifest = await buildPackage({
      store: deps.attachments!,
      conversationId: x.id,
      packageId: x.pid,
      title: x.manifest.title,
      summary: x.manifest.summary,
      candidates,
      selection,
      subtitle: `${x.l.conv.title} · prepared ${x.manifest.createdAt.slice(0, 10)} with the Helixona Assistant`,
      createdAt: x.manifest.createdAt,
      now,
    });
    await audit(deps, req, { action: "package_rebuild", conversationId: x.id, meta: { documents: selection.length, pages: manifest.pages } });
    return publicManifest(manifest);
  });
}
