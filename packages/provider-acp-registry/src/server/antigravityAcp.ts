import { type OrchestrationV2UserInputQuestion, TrimmedNonEmptyString } from "@t3tools/contracts";
import type { AcpAdapterV2Flavor } from "@t3tools/provider-acp/server/adapter";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const isForm = Schema.is(
  Schema.Struct({
    properties: Schema.Record(Schema.String, Schema.Unknown),
    required: Schema.optional(Schema.Array(Schema.String)),
  }),
);
const isChoiceHeader = Schema.is(
  Schema.Struct({
    title: TrimmedNonEmptyString,
    description: Schema.optional(Schema.String),
  }),
);
const isTextField = Schema.is(
  Schema.Struct({
    type: Schema.Literal("string"),
    title: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
  }),
);
const isFreeformQuestion = Schema.is(
  Schema.Struct({
    type: Schema.Literal("string"),
    title: TrimmedNonEmptyString,
    description: Schema.optional(Schema.String),
  }),
);

type Option = OrchestrationV2UserInputQuestion["options"][number];

type ParsedChoice =
  | {
      readonly kind: "single";
      readonly header: string;
      readonly question: string;
      readonly options: ReadonlyArray<Option>;
    }
  | {
      readonly kind: "multi";
      readonly header: string;
      readonly question: string;
      readonly options: ReadonlyArray<Option>;
      readonly minItems: number;
      readonly maxItems: number;
    };

const QUESTION_ID_PATTERN = /^q[1-9]\d*$/;
const COMPANION_SUFFIX = "_other";
const COMPANION_DESCRIPTION_PREFIX = "Optional free-form answer to:";

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function titledOption(entry: unknown): Option | undefined {
  if (!isRecord(entry) || typeof entry.const !== "string") return undefined;
  const label = text(entry.title) ?? text(entry.const);
  if (label === undefined) return undefined;
  return { label, description: text(entry.description) ?? label, value: entry.const };
}

function titledOptions(entries: unknown): ReadonlyArray<Option> | undefined {
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  const options = entries.map(titledOption);
  return options.every((option) => option !== undefined) ? options : undefined;
}

function enumOptions(entries: unknown): ReadonlyArray<Option> | undefined {
  if (
    !Array.isArray(entries) ||
    entries.length === 0 ||
    !entries.every((value): value is string => typeof value === "string")
  ) {
    return undefined;
  }
  const counts = new Map<string, number>();
  for (const value of entries) counts.set(value.trim(), (counts.get(value.trim()) ?? 0) + 1);
  const options = entries.map((value) => {
    const plain = value.trim();
    const label = plain !== "" && counts.get(plain) === 1 ? plain : JSON.stringify(value);
    return { label, description: label, value };
  });
  return new Set(options.map((option) => option.label)).size === options.length
    ? options
    : options.map((option) => {
        const label = JSON.stringify(option.value);
        return { ...option, label, description: label };
      });
}

function hasChoiceKeywords(field: Readonly<Record<string, unknown>>): boolean {
  return "enum" in field || "oneOf" in field || "anyOf" in field || "items" in field;
}

function isAntigravityCompanion(value: unknown): boolean {
  if (!isRecord(value) || !isTextField(value) || hasChoiceKeywords(value)) return false;
  return (
    value.title?.trim() === "Other" ||
    value.description?.trim().startsWith(COMPANION_DESCRIPTION_PREFIX) === true
  );
}

function parseChoiceField(field: unknown, questionNumber: number): ParsedChoice | undefined {
  if (!isRecord(field) || !isChoiceHeader(field)) return undefined;
  const header = text(field.description) ?? `Question ${questionNumber}`;
  const question = field.title.trim();

  if (field.type === "string") {
    if ("anyOf" in field || "items" in field) return undefined;
    const options = Array.isArray(field.oneOf)
      ? titledOptions(field.oneOf)
      : enumOptions(field.enum);
    if (options === undefined) return undefined;
    return { kind: "single", header, question, options };
  }

  if (field.type === "array") {
    if (!isRecord(field.items)) return undefined;
    const items = field.items;
    if (items.type !== undefined && items.type !== "string") return undefined;
    const options = Array.isArray(items.anyOf)
      ? titledOptions(items.anyOf)
      : Array.isArray(items.oneOf)
        ? titledOptions(items.oneOf)
        : enumOptions(items.enum);
    if (options === undefined) return undefined;
    const minItems =
      typeof field.minItems === "number" && Number.isInteger(field.minItems) && field.minItems >= 0
        ? field.minItems
        : 0;
    const maxItems =
      typeof field.maxItems === "number" && Number.isInteger(field.maxItems) && field.maxItems >= 0
        ? field.maxItems
        : Infinity;
    const values = new Set(options.map((option) => option.value ?? option.label));
    if (maxItems === 0 || minItems > maxItems || minItems > values.size) return undefined;
    return { kind: "multi", header, question, options, minItems, maxItems };
  }

  return undefined;
}

// Intake appends file references to a user's answer; keep them with the companion text.
const splitAttachments = (value: string) => {
  const marker = value.indexOf("\n\n");
  if (marker < 0) return undefined;
  const suffix = value.slice(marker);
  if (!/^\n\nAttached (?:image|file) "(?:\\.|[^"\\\r\n])*": "/.test(suffix)) return undefined;
  return { prefix: value.slice(0, marker), suffix };
};

const findChoice = (options: ReadonlyArray<Option>, value: string) =>
  options.find((option) => (option.value ?? option.label) === value);

/**
 * Antigravity (`agy` ACP) sends `ask_question` as `q1` + `q1_other` pairs with
 * the full question in `title` and `"The agent has N questions."` as `message`.
 * Fold each `qN_other` companion into its question so users can type custom
 * answers immediately without an extra step or truncated header.
 */
export const extractAntigravityElicitationForm: NonNullable<
  AcpAdapterV2Flavor["extractElicitationForm"]
> = (request) => {
  if (request.mode !== "form" || !isForm(request.requestedSchema)) return undefined;
  const { properties } = request.requestedSchema;
  const required = new Set(request.requestedSchema.required ?? []);
  const questions: Array<OrchestrationV2UserInputQuestion> = [];
  const specs = new Map<
    string,
    | { readonly kind: "choice"; readonly parsed: ParsedChoice; readonly hasCompanion: boolean }
    | { readonly kind: "freeform" }
  >();
  let choicePairCount = 0;

  for (const [id, field] of Object.entries(properties)) {
    if (QUESTION_ID_PATTERN.test(id)) {
      const companionId = `${id}${COMPANION_SUFFIX}`;
      const companion = properties[companionId];
      const hasCompanion = companion !== undefined;
      if (hasCompanion && (required.has(companionId) || !isAntigravityCompanion(companion))) {
        return undefined;
      }
      const parsed = parseChoiceField(field, questions.length + 1);
      if (parsed === undefined) return undefined;
      if (hasCompanion) choicePairCount += 1;
      specs.set(id, { kind: "choice", parsed, hasCompanion });
      questions.push({
        id,
        header: parsed.header,
        question: parsed.question,
        options: parsed.options,
        ...(parsed.kind === "multi" ? { multiSelect: true } : {}),
        ...(hasCompanion ? {} : { allowCustomAnswer: false }),
      });
      continue;
    }

    if (id.endsWith(COMPANION_SUFFIX)) {
      const owner = id.slice(0, -COMPANION_SUFFIX.length);
      if (!QUESTION_ID_PATTERN.test(owner)) return undefined;
      if (Object.hasOwn(properties, owner)) continue;
      if (!isRecord(field) || hasChoiceKeywords(field) || !isFreeformQuestion(field)) {
        return undefined;
      }
      specs.set(id, { kind: "freeform" });
      questions.push({
        id,
        header: text(field.description) ?? `Question ${questions.length + 1}`,
        question: field.title.trim(),
        options: [],
      });
      continue;
    }

    return undefined;
  }

  if (choicePairCount === 0) return undefined;

  return {
    questions,
    respond: (answers) => {
      const content: Record<string, EffectAcpSchema.ElicitationContentValue> = {};

      for (const question of questions) {
        const spec = specs.get(question.id);
        if (spec === undefined) return { action: "cancel" };
        const answer = Object.hasOwn(answers, question.id) ? answers[question.id] : undefined;

        if (spec.kind === "freeform") {
          if (!Predicate.isString(answer) || answer.trim().length === 0) {
            return { action: "cancel" };
          }
          content[question.id] = answer;
          continue;
        }

        const companionId = `${question.id}${COMPANION_SUFFIX}`;
        const { parsed, hasCompanion } = spec;

        if (parsed.kind === "single") {
          if (!Predicate.isString(answer)) return { action: "cancel" };
          const exact = findChoice(parsed.options, answer);
          if (exact !== undefined) {
            content[question.id] = answer;
            continue;
          }
          if (answer.trim().length === 0 || !hasCompanion) return { action: "cancel" };
          const split = splitAttachments(answer);
          const attached =
            split === undefined ? undefined : findChoice(parsed.options, split.prefix);
          if (attached !== undefined && split !== undefined) {
            content[question.id] = split.prefix;
            content[companionId] = `${attached.label}${split.suffix}`;
          } else {
            content[companionId] = answer;
          }
          continue;
        }

        // Multi-select question: option selections arrive as string[], custom text as string.
        if (Array.isArray(answer)) {
          const selected: string[] = [];
          const seen = new Set<string>();
          const extras: string[] = [];
          for (const entry of answer) {
            if (!Predicate.isString(entry)) return { action: "cancel" };
            if (findChoice(parsed.options, entry) !== undefined) {
              if (!seen.has(entry)) {
                seen.add(entry);
                selected.push(entry);
              }
            } else if (entry.trim().length > 0) {
              extras.push(entry);
            }
          }
          if (
            selected.length > 0 &&
            (selected.length < parsed.minItems || selected.length > parsed.maxItems)
          ) {
            return { action: "cancel" };
          }
          if (extras.length > 0 && !hasCompanion) return { action: "cancel" };
          if (selected.length === 0 && extras.length === 0) return { action: "cancel" };
          if (selected.length > 0) content[question.id] = selected;
          if (extras.length > 0) content[companionId] = extras.join("\n\n");
          continue;
        }

        if (Predicate.isString(answer)) {
          if (answer.trim().length === 0 || !hasCompanion) return { action: "cancel" };
          const split = splitAttachments(answer);
          const attached =
            split === undefined ? undefined : findChoice(parsed.options, split.prefix);
          if (
            attached !== undefined &&
            split !== undefined &&
            1 >= parsed.minItems &&
            1 <= parsed.maxItems
          ) {
            content[question.id] = [split.prefix];
            content[companionId] = `${attached.label}${split.suffix}`;
          } else {
            content[companionId] = answer;
          }
          continue;
        }

        return { action: "cancel" };
      }

      return { action: "accept", content };
    },
  };
};
