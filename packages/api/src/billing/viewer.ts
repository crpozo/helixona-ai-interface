import type { Config } from "../config.js";

/** Administrators named in BILLING_VIEWER_EMAILS see the billing view (usage by month, credits left). */
export function isBillingViewer(config: Pick<Config, "BILLING_VIEWER_EMAILS">, s: { email: string; roles: string[] }): boolean {
  if (!s.roles.includes("admin")) return false;
  const allowed = config.BILLING_VIEWER_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(s.email.trim().toLowerCase());
}
