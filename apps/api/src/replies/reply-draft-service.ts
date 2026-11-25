import { z } from "zod";
import {
  EditReplyDraftRequestSchema,
  ReplyDraftGenerationResultSchema,
  ReplyDraftSchemaVersion,
  type ReplyDraftGenerationResult,
  ReplyDraftServiceResponseSchema,
  type ReplyDraftServiceRequest,
  type ReplyDraftServiceResponse,
  type StoredReplyDraft
} from "@mailpilot/shared";
import { ApiError } from "../errors.js";
import type { ReplyDraftClient } from "./reply-draft-client.js";
import type { ReplyDraftStore, ReplyThreadEmail } from "./reply-draft-store.js";

const EmailIdSchema = z.uuid();
const GenerateRequestSchema = z.object({
  instruction: z.string().max(1_000).optional()
}).strict();
const MAX_CONTEXT_CHARS = 50_000;

export class ReplyDraftService {
  public constructor(
    private readonly store: ReplyDraftStore,
    private readonly drafter: ReplyDraftClient
  ) {}

  public async list(userId: string, untrustedEmailId: string): Promise<StoredReplyDraft[]> {
    const emailId = EmailIdSchema.safeParse(untrustedEmailId);
    if (!emailId.success) throw emailNotFound();
    const suggestions = await this.store.listSuggestions(userId, emailId.data);
    if (!suggestions) throw emailNotFound();
    return suggestions;
  }

  public async generate(
    userId: string,
    untrustedEmailId: string,
    untrustedBody: unknown,
    requestId?: string
  ): Promise<ReplyDraftGenerationResult> {
    const emailId = EmailIdSchema.safeParse(untrustedEmailId);
    if (!emailId.success) throw emailNotFound();
    const body = GenerateRequestSchema.safeParse(untrustedBody ?? {});
    if (!body.success) throw new ApiError(400, "INVALID_ARGUMENT", "Draft request is invalid");

    const thread = await this.store.findThreadForReply(userId, emailId.data);
    if (!thread) throw emailNotFound();
    const target = thread.find((message) => message.id === emailId.data);
    if (!target) throw emailNotFound();

    if (target.bodyText.length > 30_000) {
      throw new ApiError(413, "REPLY_DRAFT_INPUT_TOO_LARGE", "The selected email exceeds the reply drafting size limit");
    }
    const contextualMessages = selectBoundedContext(thread, target);
    const request: ReplyDraftServiceRequest = {
      userId,
      emailId: target.id,
      sourceRevision: target.sourceRevision,
      instruction: body.data.instruction ?? null,
      messages: contextualMessages
    };
    const result = ReplyDraftServiceResponseSchema.safeParse(await this.drafter.draft(request, requestId));
    if (!result.success) throw invalidAiResponse();
    validateResponse(result.data, request);

    if (!result.data.draft.canDraft) {
      return ReplyDraftGenerationResultSchema.parse({
        suggestion: null,
        missingContextReason: result.data.draft.missingContextReason,
        uncertainties: result.data.draft.uncertainties
      });
    }
    if (!result.data.provider || !result.data.modelVersion) throw invalidAiResponse();

    return ReplyDraftGenerationResultSchema.parse({
      suggestion: await this.store.saveSuggestion(result.data),
      missingContextReason: null,
      uncertainties: result.data.draft.uncertainties
    });
  }

  public async edit(
    userId: string,
    untrustedEmailId: string,
    untrustedDraftId: string,
    untrustedBody: unknown
  ): Promise<StoredReplyDraft> {
    const emailId = EmailIdSchema.safeParse(untrustedEmailId);
    const draftId = EmailIdSchema.safeParse(untrustedDraftId);
    if (!emailId.success || !draftId.success) throw draftNotFound();
    const body = EditReplyDraftRequestSchema.safeParse(untrustedBody);
    if (!body.success) throw new ApiError(400, "INVALID_ARGUMENT", "Draft edit is invalid");
    const updated = await this.store.updateSuggestion(
      userId,
      emailId.data,
      draftId.data,
      body.data.subject,
      body.data.bodyText
    );
    if (!updated) throw draftNotFound();
    return updated;
  }
}

function selectBoundedContext(
  thread: ReplyThreadEmail[],
  target: ReplyThreadEmail
): ReplyDraftServiceRequest["messages"] {
  const orderedOthers = thread
    .filter((message) => message.id !== target.id)
    .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt));
  const selected = [target];
  let total = contextLength(target);
  if (total > MAX_CONTEXT_CHARS) {
    throw new ApiError(413, "REPLY_DRAFT_INPUT_TOO_LARGE", "The selected email exceeds the reply drafting size limit");
  }
  for (const message of orderedOthers) {
    if (message.bodyText.length > 30_000) continue;
    const nextTotal = total + contextLength(message);
    if (nextTotal <= MAX_CONTEXT_CHARS) {
      selected.push(message);
      total = nextTotal;
    }
  }
  return selected.sort((left, right) => left.receivedAt.localeCompare(right.receivedAt)).map((message) => ({
    id: message.id,
    sourceRevision: message.sourceRevision,
    subject: message.subject,
    senderName: message.senderName,
    senderEmail: message.senderEmail,
    receivedAt: message.receivedAt,
    bodyText: message.bodyText
  }));
}

function contextLength(message: { subject: string; senderName: string | null; senderEmail: string | null; bodyText: string }): number {
  return message.subject.length + (message.senderName?.length ?? 0)
    + (message.senderEmail?.length ?? 0) + message.bodyText.length;
}

function validateResponse(
  result: ReplyDraftServiceResponse,
  request: ReplyDraftServiceRequest
): void {
  if (result.userId !== request.userId || result.emailId !== request.emailId
    || result.sourceRevision !== request.sourceRevision
    || result.schemaVersion !== ReplyDraftSchemaVersion
    || result.sourceMessages.length !== request.messages.length
    || !result.sourceMessages.every((source, index) => {
      const expected = request.messages[index];
      return source.id === expected?.id && source.sourceRevision === expected.sourceRevision;
    })) {
    throw invalidAiResponse();
  }

  if (!result.draft.canDraft) return;
  const target = request.messages.find((message) => message.id === request.emailId);
  if (!target || normalize(result.draft.subject) !== normalize(replySubject(target.subject))) {
    throw invalidAiResponse();
  }
  const sources = new Map(request.messages.map((message) => [message.id, message]));
  const bodyText = normalize(result.draft.bodyText);
  for (const claim of result.draft.claims) {
    const source = sources.get(claim.sourceMessageId);
    if (!source) throw invalidAiResponse();
    const sourceText = normalize([
      source.subject,
      source.senderName ?? "",
      source.senderEmail ?? "",
      source.bodyText
    ].join("\n"));
    if (!sourceText.includes(normalize(claim.evidenceQuote))
      || !bodyText.includes(normalize(claim.claim))) {
      throw invalidAiResponse();
    }
  }
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function replySubject(subject: string): string {
  const trimmed = subject.trim();
  return /^(re\s*:\s*)+/i.test(trimmed) ? trimmed : trimmed ? `Re: ${trimmed}` : "";
}

function invalidAiResponse(): ApiError {
  return new ApiError(502, "AI_RESPONSE_INVALID", "Reply drafting returned an invalid response");
}

function emailNotFound(): ApiError {
  return new ApiError(404, "EMAIL_NOT_FOUND", "Email was not found");
}

function draftNotFound(): ApiError {
  return new ApiError(404, "REPLY_DRAFT_NOT_FOUND", "Reply suggestion was not found");
}
