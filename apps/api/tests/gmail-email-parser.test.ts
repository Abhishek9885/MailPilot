import { describe, expect, it } from "vitest";
import type { GmailMessage, GmailMessagePart } from "../src/gmail/api-types.js";
import { GmailEmailParseError, parseGmailMessage } from "../src/gmail/email-parser.js";

function encodedBody(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function baseMessage(payload: GmailMessage["payload"]): GmailMessage {
  return {
    id: "message-id-1",
    threadId: "thread-id-1",
    labelIds: ["INBOX", "UNREAD"],
    internalDate: "1793232000000",
    payload
  };
}

describe("Gmail email MIME parser", () => {
  it("decodes encoded subjects and sender names and uses Gmail's internal timestamp", () => {
    const message = baseMessage({
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "=?UTF-8?Q?Jos=C3=A9_Santos?= <Jose@Example.test>" },
        { name: "Subject", value: `=?UTF-8?B?${Buffer.from("Project – Update").toString("base64")}?=` }
      ],
      body: { data: encodedBody("Hello from the project team."), size: 29 }
    });

    const parsed = parseGmailMessage(message);

    expect(parsed).toMatchObject({
      providerMessageId: "message-id-1",
      providerThreadId: "thread-id-1",
      senderName: "José Santos",
      senderEmailNormalized: "jose@example.test",
      subject: "Project – Update",
      bodyText: "Hello from the project team.",
      bodyHtml: null,
      labels: ["INBOX", "UNREAD"]
    });
    expect(parsed.receivedAt.toISOString()).toBe("2026-10-29T00:00:00.000Z");
  });

  it("parses nested multipart alternatives, sanitizes HTML, and keeps attachments metadata-only", () => {
    const message = baseMessage({
      mimeType: "multipart/mixed",
      headers: [{ name: "From", value: "Mailbox <sender@example.test>" }],
      parts: [
        {
          partId: "0",
          mimeType: "multipart/alternative",
          parts: [
            {
              partId: "0.0",
              mimeType: "text/plain",
              body: { data: encodedBody("Plain body."), size: 11 }
            },
            {
              partId: "0.1",
              mimeType: "text/html",
              body: {
                data: encodedBody(
                  '<p>Safe <strong>message</strong>.</p><script>steal()</script><a href="javascript:alert(1)">Open</a><img src="https://tracker.example.test/pixel" alt="Pixel">'
                ),
                size: 142
              }
            }
          ]
        },
        {
          partId: "1",
          mimeType: "image/png",
          filename: "chart.png",
          headers: [
            { name: "Content-Disposition", value: 'attachment; filename="chart.png"' },
            { name: "Content-ID", value: "<chart-1>" }
          ],
          body: { attachmentId: "attachment-id-1", size: 2048, data: encodedBody("attachment bytes") }
        }
      ]
    });

    const parsed = parseGmailMessage(message);

    expect(parsed.bodyText).toBe("Plain body.");
    expect(parsed.bodyHtml).toContain("<strong>message</strong>");
    expect(parsed.bodyHtml).not.toContain("<script");
    expect(parsed.bodyHtml).not.toContain("javascript:");
    expect(parsed.bodyHtml).not.toContain("tracker.example.test");
    expect(parsed.attachments).toEqual([
      {
        partId: "1",
        attachmentId: "attachment-id-1",
        filename: "chart.png",
        mimeType: "image/png",
        size: 2048,
        disposition: "attachment",
        contentId: "chart-1"
      }
    ]);
    expect(JSON.stringify(parsed.attachments)).not.toContain("attachment bytes");
  });

  it("decodes non-UTF-8 text charsets and derives searchable text for HTML-only messages", () => {
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString("base64url");
    const plainMessage = baseMessage({
      mimeType: "text/plain",
      headers: [{ name: "Content-Type", value: "text/plain; charset=iso-8859-1" }],
      body: { data: latin1, size: 4 }
    });
    const htmlMessage = baseMessage({
      mimeType: "text/html",
      body: { data: encodedBody("<p>Hello &amp; <b>welcome</b></p>") }
    });

    expect(parseGmailMessage(plainMessage).bodyText).toBe("café");
    expect(parseGmailMessage(htmlMessage)).toMatchObject({
      bodyText: "Hello & welcome",
      bodyHtml: "<p>Hello &amp; <b>welcome</b></p>"
    });
  });

  it("falls back to the Date header and rejects messages with no usable timestamp", () => {
    const dated = baseMessage({
      headers: [{ name: "Date", value: "Thu, 29 Oct 2026 10:00:00 +0530" }],
      mimeType: "text/plain",
      body: { data: encodedBody("Body") }
    });
    const invalid = { ...dated, internalDate: "invalid", payload: { headers: [] } };

    expect(parseGmailMessage({ ...dated, internalDate: undefined }).receivedAt.toISOString())
      .toBe("2026-10-29T04:30:00.000Z");
    expect(() => parseGmailMessage(invalid)).toThrowError(GmailEmailParseError);
  });

  it("enforces MIME nesting limits without exposing message content in errors", () => {
    let part: GmailMessagePart = { mimeType: "text/plain", body: { data: encodedBody("private body") } };
    for (let depth = 0; depth < 34; depth += 1) {
      part = { mimeType: "multipart/mixed", parts: [part] };
    }

    expect(() => parseGmailMessage(baseMessage(part))).toThrowError(GmailEmailParseError);
  });
});
