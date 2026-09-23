import { readFile, stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { apiError, audit, requireAuth } from "../app.js";
import { AGREEMENTS, MAX_AGREEMENT_MB, agreementFileName, agreementKey, bundledAgreementPath } from "../agreements.js";

interface AgreementFile { size: number; uploadedAt: string | null; source: "uploaded" | "bundled" }

/**
 * Business associate agreements: the list is public (status and where the originals live, the same
 * facts as the risk analysis); the clinic's PDF copy is uploaded by an administrator (presigned PUT,
 * like attachments) and downloaded by signed-in staff through the API. Until then, the vendor's
 * document bundled with the app is what they download.
 */
export function registerAgreementRoutes(app: FastifyInstance, deps: Deps): void {
  const auth = requireAuth();
  const admin = requireAuth(["admin"]);
  const find = (id: string) => AGREEMENTS.find((a) => a.id === id);
  const bundled = async (id: string): Promise<AgreementFile | null> => {
    try {
      const s = await stat(bundledAgreementPath(id));
      return { size: s.size, uploadedAt: null, source: "bundled" };
    } catch {
      return null;
    }
  };
  const fileInfo = async (id: string): Promise<AgreementFile | null> => {
    try {
      const head = await deps.attachments?.head(agreementKey(id));
      if (head) return { size: head.size, uploadedAt: head.lastModified ?? null, source: "uploaded" };
    } catch (e) {
      // Storage trouble must not take the documentation page down; the bundled copy still serves.
      deps.log.warn("agreement_head_failed", { agreement: id, errorClass: e instanceof Error ? e.name : "unknown" });
    }
    return bundled(id);
  };

  app.get("/api/agreements", async (req) => {
    const signedIn = !!req.session;
    const isAdmin = !!req.session?.roles.includes("admin");
    const items = await Promise.all(AGREEMENTS.map(async (a) => ({ ...a, file: signedIn ? await fileInfo(a.id) : null })));
    return { items, canDownload: signedIn, uploads: isAdmin && !!deps.attachments };
  });

  app.get("/api/agreements/:id/file", { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const a = find(id);
    if (!a) return apiError(reply, 404, "not_found", "No copy of this agreement is on file");
    const info = await fileInfo(id);
    if (!info) return apiError(reply, 404, "not_found", "No copy of this agreement is on file");
    const bytes = info.source === "uploaded" && deps.attachments ? await deps.attachments.get(agreementKey(id)) : await readFile(bundledAgreementPath(id));
    await audit(deps, req, { action: "agreement_downloaded", meta: { agreement: id, source: info.source } });
    return reply
      .header("content-type", "application/pdf")
      .header("content-disposition", `attachment; filename="${agreementFileName(a)}"`)
      .header("cache-control", "private, no-store")
      .send(bytes);
  });

  app.post("/api/admin/agreements/:id/upload", { preHandler: admin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!find(id)) return apiError(reply, 404, "not_found", "Unknown agreement");
    if (!deps.attachments) return apiError(reply, 400, "attachments_disabled", "File storage is not enabled on this server");
    const body = z.object({ size: z.number().int().positive(), contentType: z.string().min(1).max(100) }).safeParse(req.body);
    if (!body.success) return apiError(reply, 400, "bad_request", "Invalid request");
    if (body.data.contentType !== "application/pdf") return apiError(reply, 400, "unsupported_type", "Upload the agreement as a PDF");
    if (body.data.size > MAX_AGREEMENT_MB * 1048576) return apiError(reply, 400, "file_too_large", `The PDF is limited to ${MAX_AGREEMENT_MB} MB`);
    const upload = await deps.attachments.presignUpload(agreementKey(id), "application/pdf", 900);
    await audit(deps, req, { action: "admin_agreement_upload_url", meta: { agreement: id, size: body.data.size } });
    return { upload };
  });

  // After the browser's PUT: verify the object is there and record the upload.
  app.post("/api/admin/agreements/:id/confirm", { preHandler: admin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!find(id)) return apiError(reply, 404, "not_found", "Unknown agreement");
    if (!deps.attachments) return apiError(reply, 400, "attachments_disabled", "File storage is not enabled on this server");
    const head = await deps.attachments.head(agreementKey(id));
    if (!head) return apiError(reply, 400, "upload_missing", "The PDF did not arrive; try the upload again");
    const bytes = await deps.attachments.get(agreementKey(id));
    if ((head.contentType && !head.contentType.startsWith("application/pdf")) || !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
      await deps.attachments.delete(agreementKey(id));
      return apiError(reply, 400, "unsupported_type", "Upload the agreement as a PDF");
    }
    await audit(deps, req, { action: "admin_agreement_uploaded", meta: { agreement: id, size: head.size } });
    return { file: { size: head.size, uploadedAt: head.lastModified ?? null, source: "uploaded" } satisfies AgreementFile };
  });

  app.delete("/api/admin/agreements/:id", { preHandler: admin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!find(id)) return apiError(reply, 404, "not_found", "Unknown agreement");
    if (deps.attachments) await deps.attachments.delete(agreementKey(id));
    await audit(deps, req, { action: "admin_agreement_removed", meta: { agreement: id } });
    return reply.code(204).send();
  });
}
