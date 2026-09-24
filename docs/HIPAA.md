# HIPAA readiness guide: Helixona Assistant

This is the working checklist for taking the Helixona Assistant from "HIPAA-ready" to a system the
clinic can operate under HIPAA. It is written for the clinic owner and the person running the AWS
account. Technical safeguards are largely built in; what remains is mostly agreements, one DNS
change, and the clinic's own administrative program.

**Rule of thumb until every item in Phase A and Phase B is done: use sample or de-identified
documents only. No real patient information.**

---

## 1. Where things stand

| Area | Status | Owner |
| --- | --- | --- |
| AWS Business Associate Addendum (BAA) | **To do** — accept in AWS Artifact | Clinic (AWS account owner) |
| Anthropic BAA / HIPAA readiness for the API organization | **To do** — enable in the Claude Console | Clinic (Console org admin) |
| BAA between the clinic and its IT vendor (if the vendor keeps admin access) | **To do** | Clinic + vendor |
| Custom domain with TLS end to end (`ai.helixona.com`) | **To do** — two DNS records in GoDaddy, then redeploy | Domain owner + deploy |
| Multi-factor authentication for every user | **Done** — required by the user pool, enrolled in-app | — |
| AWS CloudTrail with data events on the PHI tables and bucket | **Done** — created by the deploy (`ENABLE_CLOUDTRAIL`, default on) | — |
| Encryption at rest (KMS) and in transit (TLS 1.2+) | Done | — |
| Server-side sessions, 15-minute idle logoff | Done | — |
| Role-based access (staff / admin), user lifecycle in the app | Done | — |
| Audit log without message content; no PHI in application logs | Done | — |
| Backups (35 days), log retention (1 year), conversation and file retention (30 days) | Done | — |
| Risk analysis, policies, training, incident response | **To do** | Clinic (Privacy/Security Officer) |

---

## 2. Step by step

### Phase A: agreements (about one hour, no code)

1. **Accept the AWS BAA.** Sign in to the clinic's AWS account as the root user or an
   administrator. Open **AWS Artifact → Agreements → Account agreements**, find the
   *AWS Business Associate Addendum*, download it, and accept it. It takes effect immediately and
   costs nothing. Keep the PDF with the compliance records.

2. **Enable HIPAA readiness with Anthropic.** Anthropic offers a standard BAA that can be accepted
   in the Claude Console by an authorized representative of the organization:
   - Open **Claude Console → Settings → Privacy** and find the **HIPAA compliance** card.
   - Download the Business Associate Agreement and the HIPAA Implementation Guide, then accept.
   - Enablement is immediate and permanent for that organization.
   - If the card is not shown, the organization is not eligible for self-serve enablement: use the
     sales form at https://claude.com/contact-sales and Anthropic will execute the BAA.

   Two things to check:
   - The organization that enables HIPAA readiness must be the one that **owns the API key** stored
     in AWS Secrets Manager as `helixona-prod-anthropic-api-key`. If that key belongs to a personal
     or vendor organization, create an organization for the clinic, enable HIPAA readiness there,
     create a new key, and replace the secret value; then force a new deployment of the ECS service.
   - HIPAA readiness applies to the whole organization. Do not mix non-clinic workloads in it.

   Nothing in the application needs to change: every API feature the assistant uses (Messages API,
   streaming, adaptive thinking, effort, prompt caching, PDFs sent inline) is on Anthropic's list of
   HIPAA-eligible features. Claude Fable 5.1 requires 30-day retention, which HIPAA readiness
   allows; zero data retention is not needed and not required.

3. **Vendor BAA.** If the IT vendor keeps administrator access to the AWS account, the Claude
   Console organization, or production data, the clinic needs a BAA with that vendor as well.

### Phase B: technical close-out

4. **Custom domain and TLS end to end.** Today users reach the app through the CloudFront URL and
   the hop from CloudFront to the load balancer inside AWS is plain HTTP. With a certificate the app
   moves to `https://ai.helixona.com` and every hop is TLS. Whoever manages `helixona.com` in
   GoDaddy adds two CNAME records:

   a. The ACM validation record. Print it from CloudShell (region `us-east-1`):

      ```bash
      export AWS_REGION=us-east-1
      aws acm describe-certificate \
        --certificate-arn arn:aws:acm:us-east-1:148274106093:certificate/06efa8d4-024a-4310-b616-65e2ef5821a7 \
        --query 'Certificate.[Status,DomainValidationOptions[0].ResourceRecord]' --output json
      ```

      If `Status` is `VALIDATION_TIMED_OUT`, request a new certificate and use the new ARN:

      ```bash
      aws acm request-certificate --domain-name ai.helixona.com --validation-method DNS --region us-east-1
      ```

   b. `ai` → `d3ff96yvf3rt0u.cloudfront.net`.

   When the certificate shows `ISSUED`, set these variables in GitHub → Settings → Environments →
   `production` and run the **Deploy** workflow:

   | Variable | Value |
   | --- | --- |
   | `DOMAIN_NAME` | `ai.helixona.com` |
   | `CERTIFICATE_ARN` | the certificate ARN |
   | `APP_BASE_URL` | `https://ai.helixona.com` |

5. **Multi-factor authentication** is enforced by the Cognito user pool (`MfaConfiguration: ON`).
   Every user enrolls an authenticator app at their first sign-in (QR code or manual key). An
   administrator can reset a lost authenticator from **Administration → Users → Reset MFA**; the
   user is signed out and enrolls again at the next sign-in.

6. **CloudTrail** is created by the deploy when `ENABLE_CLOUDTRAIL` is unset or `true`: a
   multi-region trail with log-file validation, KMS-encrypted S3 bucket, CloudWatch Logs delivery,
   and data events for the DynamoDB tables and the attachments bucket. Set the variable to `false`
   only if the organization already delivers a trail to this account.

7. **Verify after the deploy.** Sign in, enroll the authenticator, upload a sample PDF, ask a
   question, switch models, and open Administration → Audit to confirm the events are recorded.

### Phase C: the clinic's administrative program

HIPAA is mostly about how the organization operates. The clinic needs, at minimum:

8. A **written risk analysis** that covers this system (data flows in section 4, threats,
   safeguards, residual risk, decisions). Review it yearly and after major changes.
9. **Policies and procedures**: acceptable use of the assistant, access control and account
   lifecycle, password and MFA rules, data retention, incident response and breach notification,
   sanctions for policy violations, device security for staff phones and laptops.
10. **Workforce training** on those policies before access is granted, with records kept.
11. A named **Privacy Officer** and **Security Officer**.
12. **Contingency planning**: the deploy creates daily backups (35 days). Document who restores
    them and test a restore once.

### Phase D: operating procedures

| Situation | What to do |
| --- | --- |
| New staff member | Administration → Add a user. They receive a temporary password by email and enroll an authenticator on first sign-in. |
| Staff member leaves | Administration → Disable. Sessions are revoked immediately. |
| Lost or replaced phone | Administration → Reset MFA. The user enrolls again at the next sign-in. |
| Suspected compromise | Disable the user, review Administration → Audit for that day, rotate the Anthropic API key in Secrets Manager if it may have been exposed, and follow the incident policy. |
| Quarterly | Review the user list and roles, review audit logs, confirm backups and alarms are healthy. |
| Yearly | Update the risk analysis, refresh training, review BAAs and retention settings. |

---

## 3. Technical safeguards already in place

| HIPAA Security Rule area | Implementation |
| --- | --- |
| Unique user identification (§164.312(a)) | Cognito user pool, one account per person, email as identifier, admin-created only |
| Authentication (§164.312(d)) | Password (12+ characters, complexity, history of 12) plus TOTP authenticator, required for all |
| Automatic logoff (§164.312(a)) | Server-side sessions expire after 15 minutes idle and 12 hours absolute |
| Access control / least privilege | `staff` and `admin` roles; admin-only user management, usage and audit; ECS task role scoped to the app's tables, bucket and secrets |
| Audit controls (§164.312(b)) | Application audit log (who, what, when, never message content); CloudTrail management and data events; WAF and CloudFront logs; 1-year log retention |
| Integrity (§164.312(c)) | DynamoDB point-in-time recovery, versioned S3 buckets, CloudTrail log-file validation |
| Transmission security (§164.312(e)) | TLS 1.2+ at CloudFront; TLS to the load balancer once the certificate is configured; TLS to the Anthropic API; presigned uploads over HTTPS |
| Encryption at rest | Customer-managed KMS key for DynamoDB, S3, logs and secrets |
| Data minimization / retention | Conversations and uploaded files deleted after 30 days; no PHI in application logs; no PHI in Anthropic-side schemas |
| Perimeter | WAF managed rule sets and rate limits on CloudFront and on the Cognito endpoints; brute-force limiter on sign-in |
| Backups | AWS Backup daily plan, 35-day retention |
| Infrastructure assurance | cdk-nag with the AWS Solutions and HIPAA Security rule packs runs on every synth |

---

## 4. Where PHI lives

- **In transit:** browser → CloudFront (TLS) → load balancer → API container; API → Anthropic API
  (TLS). Uploaded files go browser → S3 directly with a presigned HTTPS URL.
- **At rest (clinic's AWS account, `us-east-1`):** DynamoDB `messages` and `conversations`
  tables, the S3 attachments bucket (conversation attachments and project knowledge files), all
  encrypted with the clinic's KMS key and deleted after the retention period.
- **At Anthropic:** prompts and responses are processed under the BAA and Anthropic's HIPAA
  readiness safeguards (30-day retention for Claude Fable 5.1). Anthropic does not train on this
  data.
- **Never:** application logs, audit records, CloudWatch metrics, WAF logs (message paths are
  excluded from body logging), or the GitHub repository.

---

## 5. If something goes wrong with sign-in

If the authenticator enrollment step ever misbehaves and staff cannot get in, an AWS administrator
can temporarily relax the pool from CloudShell without a redeploy, then reinstate it:

```bash
export AWS_REGION=us-east-1
POOL_ID=$(aws cognito-idp list-user-pools --max-results 10 --query "UserPools[?Name=='helixona-prod-users'].Id" --output text)
aws cognito-idp set-user-pool-mfa-config --user-pool-id "$POOL_ID" --mfa-configuration OPTIONAL \
  --software-token-mfa-configuration Enabled=true
# ... and back, once fixed:
aws cognito-idp set-user-pool-mfa-config --user-pool-id "$POOL_ID" --mfa-configuration ON \
  --software-token-mfa-configuration Enabled=true
```

Record the change and the reason in the incident log.

### Leftovers from the first CloudTrail deploy

The first deploy with CloudTrail failed (the key policy did not allow CloudTrail) and the rollback
kept three empty resources that are no longer managed by the stack. They cost about USD 1 per month
(the KMS key) and can be removed from CloudShell:

```bash
export AWS_REGION=us-east-1
aws s3 rb s3://helixona-prod-cloudtrail-148274106093 --force
aws logs delete-log-group --log-group-name /helixona/prod/cloudtrail
aws kms schedule-key-deletion --key-id 64c83ac4-bd62-43b1-8420-1a4a07bf3dbd --pending-window-in-days 7
```

---

## 6. Sources

- Anthropic, *API and data retention* (HIPAA readiness, feature eligibility):
  https://platform.claude.com/docs/en/manage-claude/api-and-data-retention
- Anthropic Trust Center (HIPAA Implementation Guide): https://trust.anthropic.com/resources
- AWS Artifact (BAA): https://console.aws.amazon.com/artifact/
- HHS, *Security Rule Guidance Material*: https://www.hhs.gov/hipaa/for-professionals/security/guidance/index.html

## Clinic documents in the app

The risk analysis, the policies and procedures and the workforce training are published inside the
application: `https://ai.helixona.com/documentation` (linked from the sign-in page and from the
sidebar) renders them on screen, and each one can be downloaded as a Word file from
`https://ai.helixona.com/docs/<file>.docx`. The page is public by design so that staff can read the
policies before they have an account; it contains no patient data and no secrets. The source of both
versions is `tools/hipaa-docs/` (see its README); regenerate and commit the outputs after any edit.

Signed-in staff complete the workforce training online, module by module: the knowledge check is
graded by the API (the answer key never reaches the browser), every attempt is stored in the
`training` table and the audit log, and a passed check is recorded with the user's name, email and
date. Nothing is signed, on screen or on paper. Administrators see the resulting training log on the Administration page and at the end of the
training document; it is the evidence of training the Privacy Officer keeps for six years. The
assistant itself stays locked (`TRAINING_REQUIRED`, on by default) until the signed-in user has a
completed record for the current training version; administrators are not exempt. A completion done
on paper is recorded by an administrator from the training log ("Record paper completion"), which
unlocks the user and keeps the log complete. A user may also choose "Skip training, I already know
this": that is an attestation, recorded and shown in the log as "Skipped (attested by user)" rather
than as a completed check, so the Privacy Officer can follow up; set `TRAINING_ALLOW_SKIP=false` to
remove the option.

The same page lists the two business associate agreements (AWS and Anthropic) with their status,
dates and where the originals live (`GET /api/agreements`, public: the same facts as Appendix B of
the risk analysis). The vendors' documents ship with the app (`packages/api/agreements/`) and are
what signed-in staff download until an administrator uploads the clinic's own copy of each one, which
then takes precedence; an uploaded copy is stored under
`agreements/` in the attachments bucket (encrypted with the PHI key, private, outside the retention
rule that expires conversation attachments) and signed-in staff download it through the API
(`GET /api/agreements/:id/file`, audited). Visitors see the status only.

## Bug reports

"Report a bug" in the sidebar opens a small text box; the description, the reporter's name and
email, the page and the browser go by email to the maintainer through an SNS topic
(`FEEDBACK_TOPIC_ARN`, key-encrypted, the address in the `feedbackEmail` context of the
infrastructure; SNS asks that inbox to confirm the subscription once). The form tells staff not to
include patient information, the API rate-limits reports per user, and the audit log records only
that a report was sent (length and page), never its text. The Administration page shows whether the
inbox has confirmed its subscription, can ask SNS for the confirmation email again, and can send a
test report.

## Shared projects

A project has one of three kinds, chosen by its owner (or an administrator) under Settings:

- **Private**: only the owner.
- **Shared with chosen people**: the owner picks members from the clinic's directory (names and
  emails of enabled accounts, `GET /api/users`). Everyone in the project sees and can continue the
  same conversations; each user turn records who wrote it, and the sidebar lists these projects under
  "Shared projects". Members can edit instructions and files; only the owner or an administrator
  changes the kind, the members, or deletes the project.
- **Shared with the clinic**: everyone may use the instructions and files; chats stay personal.

How it is stored: a shared project's conversations live under the project's own partition of the
conversations table (`userId = project:<id>`, with `createdBy` on each), so access follows the
members list rather than a per-user copy. Making a project shared moves the owner's chats in it to
the project; making it private again, removing a member, or deleting the project hands each chat
back to whoever started it (a member's leaves the project). Only one turn runs at a time in a
conversation (`busyUntil` claim; a second sender gets `409 conversation_busy`). The audit log
records `project_member_add` / `project_member_remove` with the member's id, and
`project_update` with how many conversations moved, never any chat text.

Minimum necessary: the policies document tells staff to add only the colleagues who need the work
and to remove them afterwards; the members list on the project page is the record of who can see
those conversations.

## Copying and exporting responses

A request for a document ("give me a Word", "make this a PDF", "put it in Excel") is answered with a
file card: the model writes the content inside a marked block (```document, -pdf, -txt or -csv),
and the interface shows it as a card with the title, the kind of file, Copy, a download button for
the requested format and the other formats underneath, plus a preview for reviewing the text. Word
files carry the clinic's letterhead style (a HELIXONA line, serif headings with a gold rule, tinted
table headers, page numbers); PDF goes through the browser's print dialog ("Save as PDF") with the
same style; CSV holds the document's tables for Excel; Text is plain text.

Each response has "Copy" and "Word". Both are built in the browser from the response's own text:
Copy puts a formatted flavour (HTML) and a plain flavour on the clipboard, so a paste into Word,
eClinicalWorks or email keeps headings, bold, lists and tables; Word downloads a .docx (Calibri,
headings, bullets, bordered tables) to the person's computer. Nothing is sent to a server or stored,
and no audit event is written: the copy is equivalent to selecting the text on screen. A downloaded
file may contain PHI, so the policies document asks that it be pasted into the record and then
deleted, and never kept on the desktop, in email or in a personal drive.
