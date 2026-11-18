import { addressParser, decodeWords, type Mailbox } from "postal-mime";
import sanitizeHtml from "sanitize-html";
import type { GmailMessage, GmailMessagePart, GmailHeader } from "./api-types.js";

const MAX_MIME_DEPTH = 32;
const MAX_MIME_PARTS = 1_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_HEADER_BYTES = 256 * 1024;
const MAX_FILENAME_LENGTH = 255;

const ALLOWED_EMAIL_TAGS = [...new Set([
  ...sanitizeHtml.defaults.allowedTags,
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "colgroup",
  "col",
  "caption",
  "blockquote",
  "pre",
  "code",
  "del",
  "ins",
  "abbr",
  "cite",
  "figure",
  "figcaption",
  "img"
])];

export interface ParsedGmailAttachmentMetadata {
  partId: string;
  attachmentId: string | null;
  filename: string | null;
  mimeType: string;
  size: number | null;
  disposition: "attachment" | "inline" | "other";
  contentId: string | null;
}

export interface ParsedGmailMessage {
  providerMessageId: string;
  providerThreadId: string;
  senderName: string | null;
  senderEmailNormalized: string | null;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  labels: string[];
  receivedAt: Date;
  attachments: ParsedGmailAttachmentMetadata[];
}

export class GmailEmailParseError extends Error {
  public constructor(public readonly code: "INVALID_TIMESTAMP" | "MESSAGE_LIMIT_EXCEEDED" | "INVALID_BODY_ENCODING") {
    super("Gmail message could not be parsed safely.");
    this.name = "GmailEmailParseError";
  }
}

export function parseGmailMessage(message: GmailMessage): ParsedGmailMessage {
  const headers = message.payload?.headers ?? [];
  const subject = normalizeHeaderText(decodeHeaderValue(getHeader(headers, "subject") ?? ""));
  const sender = parseSender(normalizeHeaderText(getHeader(headers, "from") ?? ""));
  const receivedAt = parseReceivedAt(message.internalDate, getHeader(headers, "date"));
  const plainBodies: string[] = [];
  const htmlBodies: string[] = [];
  const attachments: ParsedGmailAttachmentMetadata[] = [];

  let partCount = 0;
  let decodedBodyBytes = 0;
  let headerBytes = headers.reduce((total, header) => total + Buffer.byteLength(header.name + header.value, "utf8"), 0);
  if (headerBytes > MAX_HEADER_BYTES) throw new GmailEmailParseError("MESSAGE_LIMIT_EXCEEDED");

  const visitPart = (part: GmailMessagePart, depth: number, partPath: string): void => {
    partCount += 1;
    if (depth > MAX_MIME_DEPTH || partCount > MAX_MIME_PARTS) {
      throw new GmailEmailParseError("MESSAGE_LIMIT_EXCEEDED");
    }

    const mimeType = normalizeMimeType(part.mimeType);
    const partHeaders = part.headers ?? [];
    headerBytes += partHeaders.reduce(
      (total, header) => total + Buffer.byteLength(header.name + header.value, "utf8"),
      0
    );
    if (headerBytes > MAX_HEADER_BYTES) throw new GmailEmailParseError("MESSAGE_LIMIT_EXCEEDED");
    const disposition = getHeader(partHeaders, "content-disposition") ?? "";
    const contentId = normalizeContentId(getHeader(partHeaders, "content-id"));
    const filename = normalizeFilename(part.filename ?? filenameFromDisposition(disposition));
    const hasChildren = (part.parts?.length ?? 0) > 0;
    const isTextBody = mimeType === "text/plain" || mimeType === "text/html";
    const isExplicitAttachment = /^attachment\b/i.test(disposition) || filename !== null;
    const externalBody = Boolean(part.body?.attachmentId);
    const isNonTextLeaf = !hasChildren && !isTextBody;

    if (isExplicitAttachment || externalBody || isNonTextLeaf) {
      attachments.push({
        partId: part.partId?.trim() || partPath,
        attachmentId: part.body?.attachmentId ?? null,
        filename,
        mimeType: mimeType || "application/octet-stream",
        size: isValidSize(part.body?.size) ? part.body?.size ?? null : null,
        disposition: /^attachment\b/i.test(disposition)
          ? "attachment"
          : /^inline\b/i.test(disposition) || contentId !== null
            ? "inline"
            : "other",
        contentId
      });
    }

    if (!hasChildren && isTextBody && !isExplicitAttachment && !externalBody && part.body?.data !== undefined) {
      const bytes = decodeBase64Url(part.body.data);
      decodedBodyBytes += bytes.byteLength;
      if (decodedBodyBytes > MAX_BODY_BYTES) {
        throw new GmailEmailParseError("MESSAGE_LIMIT_EXCEEDED");
      }

      const text = decodeText(bytes, getHeader(partHeaders, "content-type") ?? part.mimeType ?? "");
      if (mimeType === "text/plain") plainBodies.push(text);
      if (mimeType === "text/html") htmlBodies.push(text);
    }

    for (const [index, child] of (part.parts ?? []).entries()) {
      visitPart(child, depth + 1, `${partPath}.${index}`);
    }
  };

  if (message.payload) visitPart(message.payload, 0, "0");

  const bodyHtml = htmlBodies.length > 0 ? sanitizeEmailHtml(htmlBodies.at(-1) ?? "") : null;
  const plainBody = normalizeBodyText(plainBodies.at(-1) ?? "");
  const bodyText = plainBody || (bodyHtml ? htmlToPlainText(bodyHtml) : "");
  const senderEmail = sender?.address.trim().toLowerCase();

  return {
    providerMessageId: message.id,
    providerThreadId: message.threadId,
    senderName: normalizeHeaderText(sender?.name ?? "") || null,
    senderEmailNormalized: senderEmail && senderEmail.length <= 320 ? normalizeHeaderText(senderEmail) : null,
    subject,
    bodyText,
    bodyHtml,
    labels: [...new Set(message.labelIds)],
    receivedAt,
    attachments
  };
}

export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html.replace(/\u0000/g, ""), {
    allowedTags: ALLOWED_EMAIL_TAGS,
    allowedAttributes: {
      a: ["href", "title", "name"],
      img: ["alt", "title", "width", "height"],
      table: ["border", "cellpadding", "cellspacing", "width"],
      col: ["span", "width"],
      td: ["colspan", "rowspan", "align", "valign", "width", "height"],
      th: ["colspan", "rowspan", "align", "valign", "width", "height"],
      ol: ["start"],
      li: ["value"]
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    disallowedTagsMode: "discard"
  });
}

function getHeader(headers: GmailHeader[], name: string): string | undefined {
  return headers.find((header) => header.name.toLowerCase() === name)?.value;
}

function decodeHeaderValue(value: string): string {
  try {
    return decodeWords(value.replace(/\r?\n[\t ]+/g, " "));
  } catch {
    return value;
  }
}

function normalizeHeaderText(value: string): string {
  return value.replace(/\u0000/g, "").replace(/[\r\n]+/g, " ").trim();
}

function parseSender(value: string): Mailbox | undefined {
  try {
    return addressParser(value, { flatten: true }).find(
      (mailbox): mailbox is Mailbox => typeof mailbox.address === "string" && mailbox.address.includes("@")
    );
  } catch {
    return undefined;
  }
}

function parseReceivedAt(internalDate: string | undefined, dateHeader: string | undefined): Date {
  if (internalDate && /^\d{1,16}$/.test(internalDate)) {
    const milliseconds = Number(internalDate);
    if (Number.isSafeInteger(milliseconds)) {
      const receivedAt = new Date(milliseconds);
      if (!Number.isNaN(receivedAt.getTime())) return receivedAt;
    }
  }

  const fallback = dateHeader ? new Date(dateHeader) : undefined;
  if (fallback && !Number.isNaN(fallback.getTime())) return fallback;
  throw new GmailEmailParseError("INVALID_TIMESTAMP");
}

function normalizeMimeType(value: string | undefined): string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function decodeBase64Url(value: string): Buffer {
  if (value.length > Math.ceil(MAX_BODY_BYTES * 4 / 3) + 4) {
    throw new GmailEmailParseError("MESSAGE_LIMIT_EXCEEDED");
  }
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
    throw new GmailEmailParseError("INVALID_BODY_ENCODING");
  }
  return Buffer.from(value, "base64url");
}

function decodeText(bytes: Uint8Array, contentType: string): string {
  const match = /(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i.exec(contentType);
  const charset = match?.[1] ?? match?.[2] ?? match?.[3] ?? "utf-8";
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

function normalizeFilename(filename: string | null | undefined): string | null {
  if (!filename) return null;
  const normalized = decodeHeaderValue(decodeExtendedFilename(filename))
    .replace(/[\\/\u0000-\u001f\u007f]/g, "_")
    .trim()
    .slice(0, MAX_FILENAME_LENGTH);
  return normalized || null;
}

function filenameFromDisposition(disposition: string): string | null {
  const match = /(?:^|;)\s*filename\*?\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]*))/i.exec(disposition);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function decodeExtendedFilename(filename: string): string {
  const extended = /^utf-8''(.*)$/i.exec(filename);
  if (!extended?.[1]) return filename;
  try {
    return decodeURIComponent(extended[1]);
  } catch {
    return filename;
  }
}

function normalizeContentId(contentId: string | undefined): string | null {
  const value = contentId?.trim().replace(/^<|>$/g, "");
  return value || null;
}

function isValidSize(size: number | undefined): size is number {
  return size !== undefined && Number.isSafeInteger(size) && size >= 0;
}

function normalizeBodyText(text: string): string {
  return text.replace(/\u0000/g, "").replace(/\r\n?/g, "\n");
}

function htmlToPlainText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|tr|li|h[1-6]|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_entity, decimal: string) => decodeCodePoint(Number(decimal)))
    .replace(/&#x([\da-f]+);/gi, (_entity, hex: string) => decodeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&(amp|lt|gt|quot|apos|#39);/gi, (_entity, named: string) => {
      const entities: Record<string, string> = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
        "#39": "'"
      };
      return entities[named.toLowerCase()] ?? _entity;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function decodeCodePoint(value: number): string {
  if (!Number.isInteger(value) || value <= 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
    return "�";
  }
  return String.fromCodePoint(value);
}
