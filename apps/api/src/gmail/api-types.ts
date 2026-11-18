import { z } from "zod";

export const GmailMessageRefSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1)
});
export type GmailMessageRef = z.infer<typeof GmailMessageRefSchema>;

export const ListMessagesResponseSchema = z.object({
  messages: z.array(GmailMessageRefSchema).default([]),
  nextPageToken: z.string().optional(),
  resultSizeEstimate: z.number().int().nonnegative().optional()
});
export type ListMessagesResponse = z.infer<typeof ListMessagesResponseSchema>;

export const GmailProfileSchema = z.object({
  emailAddress: z.string().email().optional(),
  historyId: z.string().min(1),
  messagesTotal: z.number().int().nonnegative().optional(),
  threadsTotal: z.number().int().nonnegative().optional()
});
export type GmailProfile = z.infer<typeof GmailProfileSchema>;

export const GmailHistoryMessageSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().optional()
});
export type GmailHistoryMessage = z.infer<typeof GmailHistoryMessageSchema>;

const GmailHistoryMessageChangeSchema = z.object({ message: GmailHistoryMessageSchema });
const GmailHistoryLabelChangeSchema = z.object({
  message: GmailHistoryMessageSchema,
  labelIds: z.array(z.string()).default([])
});

export const GmailHistoryRecordSchema = z.object({
  id: z.string().min(1),
  messagesAdded: z.array(GmailHistoryMessageChangeSchema).default([]),
  messagesDeleted: z.array(GmailHistoryMessageChangeSchema).default([]),
  labelsAdded: z.array(GmailHistoryLabelChangeSchema).default([]),
  labelsRemoved: z.array(GmailHistoryLabelChangeSchema).default([])
});
export type GmailHistoryRecord = z.infer<typeof GmailHistoryRecordSchema>;

export const ListHistoryResponseSchema = z.object({
  history: z.array(GmailHistoryRecordSchema).default([]),
  nextPageToken: z.string().optional(),
  historyId: z.string().min(1)
});
export type ListHistoryResponse = z.infer<typeof ListHistoryResponseSchema>;

export const GmailHistoryTypeSchema = z.enum(["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"]);
export type GmailHistoryType = z.infer<typeof GmailHistoryTypeSchema>;

export const GmailHeaderSchema = z.object({
  name: z.string(),
  value: z.string()
});
export type GmailHeader = z.infer<typeof GmailHeaderSchema>;

export const GmailBodyPartSchema = z.object({
  size: z.number().int().nonnegative().optional(),
  data: z.string().optional(),
  attachmentId: z.string().optional()
});

export interface GmailBodyPart {
  size?: number | undefined;
  data?: string | undefined;
  attachmentId?: string | undefined;
}

export interface GmailMessagePart {
  partId?: string | undefined;
  mimeType?: string | undefined;
  filename?: string | undefined;
  headers?: GmailHeader[] | undefined;
  body?: GmailBodyPart | undefined;
  parts?: GmailMessagePart[] | undefined;
}

export const GmailMessagePartSchema: z.ZodType<GmailMessagePart> = z.lazy(() =>
  z.object({
    partId: z.string().optional(),
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    headers: z.array(GmailHeaderSchema).optional(),
    body: GmailBodyPartSchema.optional(),
    parts: z.array(GmailMessagePartSchema).optional()
  })
);

export const GmailMessageSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  labelIds: z.array(z.string()).default([]),
  snippet: z.string().optional(),
  historyId: z.string().optional(),
  internalDate: z.string().optional(),
  payload: GmailMessagePartSchema.optional(),
  sizeEstimate: z.number().int().nonnegative().optional(),
  raw: z.string().optional()
});
export type GmailMessage = z.infer<typeof GmailMessageSchema>;

export const GmailThreadSchema = z.object({
  id: z.string().min(1),
  historyId: z.string().optional(),
  messages: z.array(GmailMessageSchema).default([])
});
export type GmailThread = z.infer<typeof GmailThreadSchema>;

export const GmailLabelColorSchema = z.object({
  textColor: z.string().optional(),
  backgroundColor: z.string().optional()
});
export type GmailLabelColor = z.infer<typeof GmailLabelColorSchema>;

export const GmailLabelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(["system", "user"]).optional(),
  color: GmailLabelColorSchema.optional(),
  messageListVisibility: z.string().optional(),
  labelListVisibility: z.string().optional(),
  messagesTotal: z.number().int().nonnegative().optional(),
  messagesUnread: z.number().int().nonnegative().optional(),
  threadsTotal: z.number().int().nonnegative().optional(),
  threadsUnread: z.number().int().nonnegative().optional()
});
export type GmailLabel = z.infer<typeof GmailLabelSchema>;

export const ListLabelsResponseSchema = z.object({
  labels: z.array(GmailLabelSchema).default([])
});
export type ListLabelsResponse = z.infer<typeof ListLabelsResponseSchema>;

export interface ListMessagesOptions {
  maxResults?: number | undefined;
  pageToken?: string | undefined;
  q?: string | undefined;
  labelIds?: string[] | undefined;
  includeSpamTrash?: boolean | undefined;
}

export interface ListHistoryOptions {
  startHistoryId: string;
  maxResults?: number | undefined;
  pageToken?: string | undefined;
  historyTypes?: GmailHistoryType[] | undefined;
}

export interface GetMessageOptions {
  format?: "minimal" | "full" | "raw" | "metadata" | undefined;
  metadataHeaders?: string[] | undefined;
}

export interface GetThreadOptions {
  format?: "minimal" | "full" | "metadata" | undefined;
  metadataHeaders?: string[] | undefined;
}

