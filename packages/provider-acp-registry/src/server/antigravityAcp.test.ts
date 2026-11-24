import type { AcpAdapterV2Flavor } from "@t3tools/provider-acp/server/adapter";
import { describe, expect, it } from "vite-plus/test";

import { extractAntigravityElicitationForm } from "./antigravityAcp.ts";

type ElicitationRequest = Parameters<NonNullable<AcpAdapterV2Flavor["extractElicitationForm"]>>[0];

const request = (
  properties: Record<string, unknown>,
  message = "The agent has 4 questions.",
  required?: ReadonlyArray<string>,
): ElicitationRequest =>
  ({
    mode: "form",
    sessionId: "session-id",
    message,
    requestedSchema: {
      type: "object",
      properties,
      ...(required === undefined ? {} : { required }),
    },
  }) as ElicitationRequest;

const q1 = {
  type: "string",
  title: "Round 1 (1/4) — MaxBook de-SPOF: Where should live production ERP live?",
  oneOf: [
    { const: "1", title: "(Recommended) Move both off MaxBook" },
    { const: "2", title: "Move live ERP only" },
    { const: "3", title: "Keep both on MaxBook" },
  ],
};
const q1Other = {
  type: "string",
  title: "Other",
  description:
    "Optional free-form answer to: Round 1 (1/4) — MaxBook de-SPOF: Where should live production ERP live?",
};
const q2 = {
  type: "array",
  title: "Round 1 (2/4) — Which providers should background workers use?",
  items: {
    anyOf: [
      { const: "1", title: "(Recommended) OpenAI Codex" },
      { const: "2", title: "Anthropic Sonnet / Haiku" },
      { const: "3", title: "Google Vertex Gemini" },
    ],
  },
};
const q2Other = {
  type: "string",
  title: "Other",
  description:
    "Optional free-form answer to: Round 1 (2/4) — Which providers should background workers use?",
};
const q3Other = {
  type: "string",
  title: "Anything else we should keep in mind?",
};
const attachment = '\n\nAttached image "shot.png": "/tmp/shot.png"';

describe("Antigravity ACP question form", () => {
  it("folds single-select qN and qN_other pairs into single custom-answerable questions", () => {
    const form = extractAntigravityElicitationForm(
      request(
        {
          q1,
          q1_other: q1Other,
          q2: {
            type: "string",
            title: "Round 2 — Which deployment target?",
            oneOf: [
              { const: "1", title: "Staging" },
              { const: "2", title: "Production" },
            ],
          },
          q2_other: {
            type: "string",
            title: "Other",
            description: "Optional free-form answer to: Round 2 — Which deployment target?",
          },
        },
        "The agent has 2 questions.",
      ),
    );

    expect(form?.questions).toEqual([
      {
        id: "q1",
        header: "Question 1",
        question: q1.title,
        options: [
          {
            label: "(Recommended) Move both off MaxBook",
            description: "(Recommended) Move both off MaxBook",
            value: "1",
          },
          { label: "Move live ERP only", description: "Move live ERP only", value: "2" },
          { label: "Keep both on MaxBook", description: "Keep both on MaxBook", value: "3" },
        ],
      },
      {
        id: "q2",
        header: "Question 2",
        question: "Round 2 — Which deployment target?",
        options: [
          { label: "Staging", description: "Staging", value: "1" },
          { label: "Production", description: "Production", value: "2" },
        ],
      },
    ]);
    expect(form?.questions.every((question) => question.allowCustomAnswer !== false)).toBe(true);

    expect(
      form?.respond({
        q1: "1",
        q2: "Option 1, except keep Qwen 3.8 disabled",
      }),
    ).toEqual({
      action: "accept",
      content: {
        q1: "1",
        q2_other: "Option 1, except keep Qwen 3.8 disabled",
      },
    });
  });

  it("folds mixed single-select, multi-select, and unpaired freeform questions", () => {
    const form = extractAntigravityElicitationForm(
      request({
        q1,
        q1_other: q1Other,
        q2,
        q2_other: q2Other,
        q3_other: q3Other,
      }),
    );

    expect(form?.questions).toEqual([
      {
        id: "q1",
        header: "Question 1",
        question: q1.title,
        options: [
          {
            label: "(Recommended) Move both off MaxBook",
            description: "(Recommended) Move both off MaxBook",
            value: "1",
          },
          { label: "Move live ERP only", description: "Move live ERP only", value: "2" },
          { label: "Keep both on MaxBook", description: "Keep both on MaxBook", value: "3" },
        ],
      },
      {
        id: "q2",
        header: "Question 2",
        question: q2.title,
        multiSelect: true,
        options: [
          {
            label: "(Recommended) OpenAI Codex",
            description: "(Recommended) OpenAI Codex",
            value: "1",
          },
          {
            label: "Anthropic Sonnet / Haiku",
            description: "Anthropic Sonnet / Haiku",
            value: "2",
          },
          {
            label: "Google Vertex Gemini",
            description: "Google Vertex Gemini",
            value: "3",
          },
        ],
      },
      {
        id: "q3_other",
        header: "Question 3",
        question: q3Other.title,
        options: [],
      },
    ]);

    expect(
      form?.respond({
        q1: "1",
        q2: ["1", "3"],
        q3_other: "Skip backups during maintenance",
      }),
    ).toEqual({
      action: "accept",
      content: {
        q1: "1",
        q2: ["1", "3"],
        q3_other: "Skip backups during maintenance",
      },
    });

    // A custom string answer typed into a multi-select question routes to q2_other.
    expect(
      form?.respond({
        q1: "2",
        q2: "Codex + Vertex, but exclude local MLX Qwen 3.8",
        q3_other: "None",
      }),
    ).toEqual({
      action: "accept",
      content: {
        q1: "2",
        q2_other: "Codex + Vertex, but exclude local MLX Qwen 3.8",
        q3_other: "None",
      },
    });
  });

  it("keeps attachment text alongside selected options for both single- and multi-select", () => {
    const form = extractAntigravityElicitationForm(
      request({
        q1,
        q1_other: q1Other,
        q2,
        q2_other: q2Other,
      }),
    );

    expect(
      form?.respond({
        q1: `1${attachment}`,
        q2: ["1", "2", 'Attached image "shot.png": "/tmp/shot.png"'],
      }),
    ).toEqual({
      action: "accept",
      content: {
        q1: "1",
        q1_other: `(Recommended) Move both off MaxBook${attachment}`,
        q2: ["1", "2"],
        q2_other: 'Attached image "shot.png": "/tmp/shot.png"',
      },
    });
  });

  it("cancels when answers are empty, missing, or invalid", () => {
    const form = extractAntigravityElicitationForm(
      request({
        q1,
        q1_other: q1Other,
        q2,
        q2_other: q2Other,
      }),
    );

    expect(form?.respond({})).toEqual({ action: "cancel" });
    expect(form?.respond({ q1: "  ", q2: ["1"] })).toEqual({ action: "cancel" });
    expect(form?.respond({ q1: ["1"], q2: ["1"] })).toEqual({ action: "cancel" });
    expect(form?.respond({ q1: "1", q2: [] })).toEqual({ action: "cancel" });
    expect(form?.respond({ q1: "1", q2: "   " })).toEqual({ action: "cancel" });
  });

  it.each([
    ["an arbitrary MCP text form", { name: { type: "string", title: "Name" } }],
    [
      "OMP double-underscore companion fields",
      {
        q1,
        q1__other: { type: "string", title: "Other (type your own)" },
      },
    ],
    ["a choice form without any companion", { q1 }],
    ["an unrelated extra property", { q1, q1_other: q1Other, extra: { type: "string" } }],
    ["a required companion", { q1, q1_other: q1Other }, ["q1_other"] as ReadonlyArray<string>],
    ["only an unpaired _other field", { q1_other: q3Other }],
  ])("leaves %s to the generic mapping", (_, properties, required?: ReadonlyArray<string>) => {
    expect(
      extractAntigravityElicitationForm(request(properties, "Prompt", required)),
    ).toBeUndefined();
  });
});
