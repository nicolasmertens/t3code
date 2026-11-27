import * as Schema from "effect/Schema";

export const DiscussEmailsScope = Schema.Literals(["core", "all"]);
export type DiscussEmailsScope = typeof DiscussEmailsScope.Type;

export const DiscussEmailsSourceKind = Schema.Literals([
  "godwit",
  "postroom",
  "journal",
  "offline",
]);
export type DiscussEmailsSourceKind = typeof DiscussEmailsSourceKind.Type;

export const DiscussEmailsBucket = Schema.Literals(["urgent", "decision", "follow_up"]);
export type DiscussEmailsBucket = typeof DiscussEmailsBucket.Type;

export const DiscussEmailItem = Schema.Struct({
  id: Schema.String,
  godwitThreadId: Schema.optional(Schema.Number),
  account: Schema.String,
  subject: Schema.String,
  from: Schema.String,
  date: Schema.String,
  snippet: Schema.String,
  bucket: DiscussEmailsBucket,
  score: Schema.Number,
  reasons: Schema.Array(Schema.String),
  unreadCount: Schema.Number,
  flagged: Schema.Boolean,
  hasAttachments: Schema.Boolean,
  waitingDays: Schema.optional(Schema.Number),
  deadline: Schema.optional(Schema.NullOr(Schema.String)),
  amount: Schema.optional(Schema.NullOr(Schema.String)),
  realm: Schema.optional(Schema.String),
  victorAllowlisted: Schema.Boolean,
});
export type DiscussEmailItem = typeof DiscussEmailItem.Type;

export const PrepareDiscussEmailsInput = Schema.Struct({
  scope: Schema.optional(DiscussEmailsScope),
  limit: Schema.optional(Schema.Number),
});
export type PrepareDiscussEmailsInput = typeof PrepareDiscussEmailsInput.Type;

export const PrepareDiscussEmailsResult = Schema.Struct({
  generatedAt: Schema.String,
  title: Schema.String,
  prompt: Schema.String,
  primarySource: DiscussEmailsSourceKind,
  degradedNotes: Schema.Array(Schema.String),
  accountsChecked: Schema.Array(Schema.String),
  totalCandidates: Schema.Number,
  items: Schema.Array(DiscussEmailItem),
});
export type PrepareDiscussEmailsResult = typeof PrepareDiscussEmailsResult.Type;
