import { ListSubscriptionsByTopicCommand, PublishCommand, SNSClient, SubscribeCommand } from "@aws-sdk/client-sns";

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

/** Whether the maintainer's inbox will actually receive the reports. */
export type SubscriptionState = "confirmed" | "pending" | "none" | "unknown";
export interface FeedbackStatus {
  email: string | null;
  subscription: SubscriptionState;
}

export interface FeedbackSender {
  send(report: BugReport): Promise<void>;
  status(): Promise<FeedbackStatus>;
  /** Sends the confirmation email again (a new subscription request for the same address). */
  resendConfirmation(): Promise<void>;
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

/**
 * Publishes the report to an SNS topic whose email subscription is the maintainer's inbox. SNS
 * delivers nothing to an address until its owner clicks the confirmation link SNS emails, so the
 * sender can also report that state and ask SNS to send the link again.
 */
export class SnsFeedbackSender implements FeedbackSender {
  private readonly client: SNSClient;
  private readonly email: string | null;
  constructor(region: string, private readonly topicArn: string, email: string | null | undefined) {
    this.client = new SNSClient({ region });
    this.email = email?.trim() || null;
  }
  async send(report: BugReport): Promise<void> {
    const { subject, body } = formatBugReport(report);
    await this.client.send(new PublishCommand({ TopicArn: this.topicArn, Subject: subject, Message: body }));
  }
  async status(): Promise<FeedbackStatus> {
    if (!this.email) return { email: null, subscription: "none" };
    const wanted = this.email.toLowerCase();
    let token: string | undefined;
    do {
      const r = await this.client.send(new ListSubscriptionsByTopicCommand({ TopicArn: this.topicArn, NextToken: token }));
      for (const s of r.Subscriptions ?? []) {
        if (s.Protocol === "email" && (s.Endpoint ?? "").toLowerCase() === wanted) {
          return { email: this.email, subscription: s.SubscriptionArn === "PendingConfirmation" ? "pending" : "confirmed" };
        }
      }
      token = r.NextToken;
    } while (token);
    return { email: this.email, subscription: "none" };
  }
  async resendConfirmation(): Promise<void> {
    if (!this.email) throw new Error("No feedback email is configured");
    await this.client.send(new SubscribeCommand({ TopicArn: this.topicArn, Protocol: "email", Endpoint: this.email }));
  }
}

/** Development and tests: keeps the reports in memory and counts confirmation requests. */
export class MemoryFeedbackSender implements FeedbackSender {
  readonly reports: BugReport[] = [];
  confirmations = 0;
  constructor(private readonly email: string | null = "maintainer@example.test") {}
  async send(report: BugReport): Promise<void> {
    this.reports.push(report);
  }
  async status(): Promise<FeedbackStatus> {
    return { email: this.email, subscription: this.email ? "confirmed" : "none" };
  }
  async resendConfirmation(): Promise<void> {
    this.confirmations++;
  }
}
