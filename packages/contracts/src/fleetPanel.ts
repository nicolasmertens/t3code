import * as Schema from "effect/Schema";

export const FleetPanelModuleStatus = Schema.Literals(["ok", "degraded", "offline"]);
export type FleetPanelModuleStatus = typeof FleetPanelModuleStatus.Type;

export const FleetHostEntry = Schema.Struct({
  alias: Schema.String,
  role: Schema.String,
  ok: Schema.Boolean,
  detail: Schema.optional(Schema.String),
});
export type FleetHostEntry = typeof FleetHostEntry.Type;

export const FleetDegradedSensor = Schema.Struct({
  name: Schema.String,
  host: Schema.String,
  detail: Schema.String,
});
export type FleetDegradedSensor = typeof FleetDegradedSensor.Type;

export const FleetAttachmentSummary = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  updatedAt: Schema.optional(Schema.String),
});
export type FleetAttachmentSummary = typeof FleetAttachmentSummary.Type;

export const FleetPulsePayload = Schema.Struct({
  status: FleetPanelModuleStatus,
  note: Schema.optional(Schema.String),
  hostName: Schema.String,
  hosts: Schema.Array(FleetHostEntry),
  degradedSensors: Schema.Array(FleetDegradedSensor),
  recentMeetings: Schema.Array(FleetAttachmentSummary),
  storageFiles: Schema.Array(FleetAttachmentSummary),
  screenObserver: Schema.Struct({
    available: Schema.Boolean,
    updatedAt: Schema.optional(Schema.String),
  }),
});
export type FleetPulsePayload = typeof FleetPulsePayload.Type;

export const FleetPlanTask = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  deadline: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.String),
  source: Schema.String,
});
export type FleetPlanTask = typeof FleetPlanTask.Type;

export const FleetPlanPayload = Schema.Struct({
  status: FleetPanelModuleStatus,
  note: Schema.optional(Schema.String),
  primaryFocus: Schema.String,
  ambitions: Schema.Array(Schema.String),
  matchedTasks: Schema.Array(FleetPlanTask),
  waitingItems: Schema.Array(FleetPlanTask),
  driftWarning: Schema.optional(Schema.String),
  timeBoundary: Schema.Struct({
    etTime: Schema.String,
    label: Schema.String,
    isStopSoon: Schema.Boolean,
    isTrainingDay: Schema.Boolean,
  }),
});
export type FleetPlanPayload = typeof FleetPlanPayload.Type;

export const FleetMailMessage = Schema.Struct({
  id: Schema.String,
  subject: Schema.String,
  from: Schema.String,
  date: Schema.String,
  snippet: Schema.String,
  account: Schema.optional(Schema.String),
  isDraft: Schema.optional(Schema.Boolean),
  hasAttachments: Schema.optional(Schema.Boolean),
  allowlistOwner: Schema.optional(Schema.Boolean),
});
export type FleetMailMessage = typeof FleetMailMessage.Type;

export const FleetMailPayload = Schema.Struct({
  status: FleetPanelModuleStatus,
  note: Schema.optional(Schema.String),
  queryUsed: Schema.String,
  messages: Schema.Array(FleetMailMessage),
  draftsCount: Schema.Number,
  followUpOwner: Schema.Struct({
    name: Schema.String,
    address: Schema.String,
    allowlisted: Schema.Boolean,
    domains: Schema.Array(Schema.String),
  }),
});
export type FleetMailPayload = typeof FleetMailPayload.Type;

export const FleetLibrarianCard = Schema.Struct({
  slug: Schema.String,
  title: Schema.String,
  path: Schema.String,
  freshness: Schema.Literals(["verified", "stale", "unknown"]),
  updatedAt: Schema.optional(Schema.String),
  nextAction: Schema.optional(Schema.String),
});
export type FleetLibrarianCard = typeof FleetLibrarianCard.Type;

export const FleetStandingRule = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  summary: Schema.String,
  locked: Schema.Boolean,
});
export type FleetStandingRule = typeof FleetStandingRule.Type;

export const FleetLibrarianPayload = Schema.Struct({
  status: FleetPanelModuleStatus,
  note: Schema.optional(Schema.String),
  matchedCards: Schema.Array(FleetLibrarianCard),
  activeRules: Schema.Array(FleetStandingRule),
  financeFrontierRequired: Schema.Boolean,
});
export type FleetLibrarianPayload = typeof FleetLibrarianPayload.Type;

export const FleetOpenBotDirector = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  role: Schema.String,
  domain: Schema.String,
  lane: Schema.Literals(["groene-laan", "finance-gate", "specialist"]),
  recommended: Schema.Boolean,
});
export type FleetOpenBotDirector = typeof FleetOpenBotDirector.Type;

export const FleetOpenBotsPayload = Schema.Struct({
  status: FleetPanelModuleStatus,
  note: Schema.optional(Schema.String),
  frozen: Schema.Boolean,
  reachable: Schema.Boolean,
  bots: Schema.Array(FleetOpenBotDirector),
});
export type FleetOpenBotsPayload = typeof FleetOpenBotsPayload.Type;

export const FleetProviderPoolStatus = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  state: Schema.Literals(["ok", "limited", "unknown"]),
  detail: Schema.optional(Schema.String),
});
export type FleetProviderPoolStatus = typeof FleetProviderPoolStatus.Type;

export const FleetBrownePayload = Schema.Struct({
  status: FleetPanelModuleStatus,
  note: Schema.optional(Schema.String),
  shackleNumber: Schema.Number,
  itemCount: Schema.Number,
  estimatedTokens: Schema.Number,
  softWatermarkTokens: Schema.Number,
  hardWatermarkTokens: Schema.Number,
  estimatedSavingsPct: Schema.Number,
  autoShackleEnabled: Schema.Boolean,
  financeFrontierLocked: Schema.Boolean,
  providers: Schema.Array(FleetProviderPoolStatus),
  grounding: Schema.Struct({
    toolReceipts: Schema.Number,
    verifiedSources: Schema.Array(Schema.String),
    verdict: Schema.Literals(["sound", "unverified", "pending"]),
  }),
});
export type FleetBrownePayload = typeof FleetBrownePayload.Type;

export const FleetTrayItem = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["approval", "hand_atom", "outbound"]),
  title: Schema.String,
  detail: Schema.String,
  url: Schema.optional(Schema.String),
  copyText: Schema.optional(Schema.String),
  decision: Schema.Literals(["pending", "approved", "rejected"]),
});
export type FleetTrayItem = typeof FleetTrayItem.Type;

export const FleetTrayPayload = Schema.Struct({
  status: FleetPanelModuleStatus,
  note: Schema.optional(Schema.String),
  items: Schema.Array(FleetTrayItem),
  settled: Schema.Boolean,
  lockedAt: Schema.optional(Schema.String),
});
export type FleetTrayPayload = typeof FleetTrayPayload.Type;

export const FleetPanelContextInput = Schema.Struct({
  threadId: Schema.String,
  projectId: Schema.optional(Schema.String),
  projectName: Schema.optional(Schema.String),
  threadTitle: Schema.optional(Schema.String),
  workspaceRoot: Schema.optional(Schema.String),
  query: Schema.optional(Schema.String),
  forceRefresh: Schema.optional(Schema.Boolean),
});
export type FleetPanelContextInput = typeof FleetPanelContextInput.Type;

export const FleetPanelContextResult = Schema.Struct({
  generatedAt: Schema.String,
  keywords: Schema.Array(Schema.String),
  fleet: FleetPulsePayload,
  plan: FleetPlanPayload,
  mail: FleetMailPayload,
  librarian: FleetLibrarianPayload,
  openbots: FleetOpenBotsPayload,
  browne: FleetBrownePayload,
  tray: FleetTrayPayload,
});
export type FleetPanelContextResult = typeof FleetPanelContextResult.Type;

export const FleetPanelActionInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("commitLibrarian"),
    threadId: Schema.String,
    fact: Schema.String,
    factKind: Schema.Literals(["decision", "event"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("fetchMailBody"),
    query: Schema.String,
    messageId: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("openGodwit"),
  }),
  Schema.Struct({
    kind: Schema.Literal("logWaiting"),
    threadId: Schema.String,
    title: Schema.String,
    owner: Schema.optional(Schema.String),
    deadline: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("handoffBot"),
    threadId: Schema.String,
    botId: Schema.String,
    botName: Schema.String,
    goal: Schema.String,
    constraints: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("toggleBotFreeze"),
    frozen: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("attachFleet"),
    target: Schema.Literals(["screen", "meeting", "storage"]),
    path: Schema.optional(Schema.String),
    query: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("launchRealCli"),
    model: Schema.Literals(["opus", "fable"]),
    threadTitle: Schema.optional(Schema.String),
    cwd: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("decideTrayItem"),
    threadId: Schema.String,
    itemId: Schema.String,
    decision: Schema.Literals(["pending", "approved", "rejected"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("lockDecisionAndSettle"),
    threadId: Schema.String,
    summary: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("rollShackleHint"),
    threadId: Schema.String,
  }),
]);
export type FleetPanelActionInput = typeof FleetPanelActionInput.Type;

export const FleetPanelActionResult = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.String,
  injectText: Schema.optional(Schema.String),
  copyText: Schema.optional(Schema.String),
  attachmentPath: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
});
export type FleetPanelActionResult = typeof FleetPanelActionResult.Type;
