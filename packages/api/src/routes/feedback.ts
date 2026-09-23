import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { apiError, audit, requireAuth } from "../app.js";
import type { BugReport } from "../feedback.js";

const WINDOW_MS = 3_600_000;
const MAX_PER_HOUR = 10;

/**
 * "Report a bug" from the sidebar: the description goes by email to the person who runs the
 * assistant (an SNS topic with their address subscribed). The app keeps only an audit entry that a
 * report was sent, never its text, since a user may describe patient data by mistake.
 */
export function registerFeedbackRoutes(app: FastifyInstance, deps: Deps): void {
  const now = deps.now ?? (() => new Date());
  const recent = new Map<string, number[]>();

  app.post("/api/feedback/bug", { preHandler: requireAuth() }, async (req, reply) => {
    if (!deps.feedback) return apiError(reply, 503, "feedback_disabled", "Bug reports are not enabled on this server");
    const body = z.object({ description: z.string().trim().min(10).max(2000), page: z.string().max(200).optional() }).safeParse(req.body);
    if (!body.success) return apiError(reply, 400, "bad_request", "Describe the problem in 10 to 2000 characters");
    const s = req.session!;
    const t = now().getTime();
    const times = (recent.get(s.userId) ?? []).filter((x) => t - x < WINDOW_MS);
    if (times.length >= MAX_PER_HOUR) return apiError(reply, 429, "too_many_reports", "Please wait a while before sending another report");
    times.push(t);
    recent.set(s.userId, times);
    const page = (body.data.page ?? "").split("?")[0]!.slice(0, 200);
    const report: BugReport = {
      reporterName: s.name,
      reporterEmail: s.email,
      description: body.data.description,
      page,
      userAgent: String(req.headers["user-agent"] ?? "").slice(0, 200),
      at: now().toISOString(),
    };
    try {
      await deps.feedback.send(report);
    } catch (e) {
      deps.log.error("feedback_send_failed", { errorClass: e instanceof Error ? e.name : "unknown", requestId: req.requestId });
      return apiError(reply, 502, "feedback_failed", "The report could not be sent right now. Please try again later");
    }
    await audit(deps, req, { action: "bug_reported", meta: { length: body.data.description.length, page } });
    return { ok: true };
  });
}
