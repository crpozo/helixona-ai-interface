import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";

/** A bug report typed by a signed-in user, delivered by email to the person who runs the assistant. */
export interface BugReport {
  reporterName: string;
  reporterEmail: string;
  description: string;
  /** Path of the page the report was sent from (no query string). */
  page: string;
  userAgent: string;
  at: string;
}

export interface FeedbackSender {
  send(report: BugReport): Promise<void>;
}

export function formatBugReport(r: BugReport): { subject: string; body: string } {
  const who = r.reporterName ? `${r.reporterName} (${r.reporterEmail})` : r.reporterEmail;
  // SNS subjects are limited to 100 ASCII characters.
  const subject = `[Helixona Assistant] Bug report from ${r.reporterName || r.reporterEmail}`.replace(/[^\x20-\x7e]/g, "?").slice(0, 100);
  const body = [
    "A user of the Helixona Assistant reported a problem.",
    "",
    `From: ${who}`,
    `When: ${r.at}`,
    `Page: ${r.page || "(unknown)"}`,
    `Browser: ${r.userAgent || "(unknown)"}`,
    "",
    "Description:",
    r.description,
    "",
    "Sent by the Report a bug form in the sidebar.",
  ].join("\n");
  return { subject, body };
}

/** Publishes the report to an SNS topic whose email subscription is the maintainer's inbox. */
export class SnsFeedbackSender implements FeedbackSender {
  private readonly client: SNSClient;
  constructor(region: string, private readonly topicArn: string) {
    this.client = new SNSClient({ region });
  }
  async send(report: BugReport): Promise<void> {
    const { subject, body } = formatBugReport(report);
    await this.client.send(new PublishCommand({ TopicArn: this.topicArn, Subject: subject, Message: body }));
  }
}

/** Development and tests: keeps the reports in memory. */
export class MemoryFeedbackSender implements FeedbackSender {
  readonly reports: BugReport[] = [];
  async send(report: BugReport): Promise<void> {
    this.reports.push(report);
  }
}
