import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The clinic's business associate agreements behind the assistant. The originals live with each
 * vendor; the clinic may keep its own PDF copy on file in the attachments bucket (never expiring,
 * encrypted with the PHI key, readable by signed-in staff, managed by administrators).
 */
export interface AgreementDef {
  id: string;
  vendor: string;
  title: string;
  /** ISO date the agreement became effective for the clinic. */
  since: string;
  status: string;
  /** Where the original lives at the vendor. */
  reference: string;
  url: string;
  note: string;
}

export const AGREEMENTS: readonly AgreementDef[] = [
  {
    id: "aws-baa",
    vendor: "Amazon Web Services",
    title: "AWS Business Associate Addendum",
    since: "2026-09-22",
    status: "Accepted by the account owner on September 22, 2026",
    reference: "AWS Artifact (account 148274106093), Agreements, AWS Business Associate Addendum",
    url: "https://console.aws.amazon.com/artifact/home#/agreements",
    note: "Covers the HIPAA-eligible AWS services the assistant runs on (Appendix A of the risk analysis).",
  },
  {
    id: "anthropic-baa",
    vendor: "Anthropic",
    title: "Business Associate Agreement (HIPAA readiness)",
    since: "2026-09-15",
    status: "Enabled by the account owner on September 15, 2026",
    reference: "Claude Console, Settings, Privacy (HIPAA readiness)",
    url: "https://platform.claude.com/",
    note: "Covers the assistant's calls to the Anthropic API for every model in the catalog.",
  },
];

export const MAX_AGREEMENT_MB = 25;

/**
 * The vendor's document shipped with the app (packages/api/agreements/<id>.pdf). It is served to
 * signed-in staff until an administrator uploads the clinic's own copy, which then takes precedence.
 */
export function bundledAgreementPath(id: string): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agreements", `${id}.pdf`);
}

export function agreementKey(id: string): string {
  return `agreements/${id}.pdf`;
}

/** File name of the downloaded copy, e.g. AWS-Business-Associate-Addendum.pdf. */
export function agreementFileName(a: AgreementDef): string {
  return `${a.title.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")}.pdf`;
}
