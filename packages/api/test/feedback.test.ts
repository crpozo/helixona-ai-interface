import { describe, expect, it } from "vitest";
import { ListSubscriptionsByTopicCommand, PublishCommand, SubscribeCommand } from "@aws-sdk/client-sns";
import { SnsFeedbackSender, formatBugReport } from "../src/feedback.js";

const TOPIC = "arn:aws:sns:us-east-1:123456789012:feedback";
const CONFIRMED = `${TOPIC}:bbde16ed-83a7-413d-923c-31ff8251d9a3`;

/** A stand-in for the SNS client: pages of subscriptions, and a record of what was sent. */
function fakeSns(pages: { Subscriptions: { Protocol: string; Endpoint: string; SubscriptionArn: string }[]; NextToken?: string }[]) {
  const sent: unknown[] = [];
  return {
    sent,
    async send(cmd: unknown) {
      sent.push(cmd);
      if (cmd instanceof ListSubscriptionsByTopicCommand) {
        const token = cmd.input.NextToken;
        return pages[token ? Number(token) : 0]!;
      }
      if (cmd instanceof SubscribeCommand) return { SubscriptionArn: "pending confirmation" };
      if (cmd instanceof PublishCommand) return { MessageId: "m1" };
      throw new Error("unexpected command");
    },
  };
}

describe("SnsFeedbackSender", () => {
  it("reports the inbox as confirmed when a confirmed row exists, even next to a pending duplicate on a later page", async () => {
    const sns = fakeSns([
      { Subscriptions: [{ Protocol: "email", Endpoint: "Carlos@Example.test", SubscriptionArn: "PendingConfirmation" }], NextToken: "1" },
      { Subscriptions: [{ Protocol: "sqs", Endpoint: "arn:aws:sqs:us-east-1:123456789012:q", SubscriptionArn: `${TOPIC}:other` }, { Protocol: "email", Endpoint: "carlos@example.test", SubscriptionArn: CONFIRMED }] },
    ]);
    const sender = new SnsFeedbackSender("us-east-1", TOPIC, "carlos@example.test", sns);
    expect(await sender.status()).toEqual({ email: "carlos@example.test", subscription: "confirmed" });
  });

  it("reports pending when only unconfirmed rows exist, and none when the address is absent", async () => {
    const pending = new SnsFeedbackSender("us-east-1", TOPIC, "carlos@example.test", fakeSns([{ Subscriptions: [{ Protocol: "email", Endpoint: "carlos@example.test", SubscriptionArn: "PendingConfirmation" }] }]));
    expect(await pending.status()).toEqual({ email: "carlos@example.test", subscription: "pending" });
    const none = new SnsFeedbackSender("us-east-1", TOPIC, "carlos@example.test", fakeSns([{ Subscriptions: [{ Protocol: "email", Endpoint: "someone@example.test", SubscriptionArn: CONFIRMED }] }]));
    expect(await none.status()).toEqual({ email: "carlos@example.test", subscription: "none" });
    const unset = new SnsFeedbackSender("us-east-1", TOPIC, "  ", fakeSns([]));
    expect(await unset.status()).toEqual({ email: null, subscription: "none" });
  });

  it("publishes the formatted report and subscribes the inbox again on a resend", async () => {
    const sns = fakeSns([]);
    const sender = new SnsFeedbackSender("us-east-1", TOPIC, "carlos@example.test", sns);
    const report = { reporterName: "Ana Pérez", reporterEmail: "ana@clinic.test", description: "The Send button does nothing.", page: "/c/01ABC", userAgent: "TestBrowser/1.0", at: "2026-09-23T12:00:00.000Z" };
    await sender.send(report);
    const publish = sns.sent[0] as PublishCommand;
    expect(publish).toBeInstanceOf(PublishCommand);
    expect(publish.input.TopicArn).toBe(TOPIC);
    expect(publish.input.Subject).toBe("[Helixona Assistant] Bug report from Ana P?rez");
    expect(publish.input.Message).toContain("ana@clinic.test");
    await sender.resendConfirmation();
    const sub = sns.sent[1] as SubscribeCommand;
    expect(sub).toBeInstanceOf(SubscribeCommand);
    expect(sub.input).toMatchObject({ TopicArn: TOPIC, Protocol: "email", Endpoint: "carlos@example.test" });
  });

  it("keeps the subject ASCII and under 100 characters", () => {
    const { subject } = formatBugReport({ reporterName: "Ñ".repeat(120), reporterEmail: "x@y.test", description: "d", page: "", userAgent: "", at: "" });
    expect(subject.length).toBe(99);
    expect(subject).toMatch(/^[\x20-\x7e]+$/);
  });
});
