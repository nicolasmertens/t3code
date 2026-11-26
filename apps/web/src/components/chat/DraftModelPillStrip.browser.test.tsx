import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { InlineComposerEffortControl } from "./ComposerModelEffort";
import { DraftModelPillStrip } from "./DraftModelPillStrip";
import type { DraftModelPillItem } from "./draftModelPills.logic";
import type { TraitsSelectionInput } from "./TraitsPicker";

const neonModel: ServerProviderModel = {
  slug: "gemini-4-neon",
  name: "Gemini 4 Neon",
  shortName: "4 Neon",
  isCustom: false,
  capabilities: createModelCapabilities({
    optionDescriptors: [
      {
        id: "thought_level",
        label: "Thinking",
        type: "select",
        role: "reasoning",
        currentValue: "high",
        options: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
          { id: "xhigh", label: "xHigh" },
        ],
      },
    ],
  }),
};

const pills: ReadonlyArray<DraftModelPillItem> = [
  {
    key: "antigravity_max_antigravity:gemini-4-neon",
    instanceId: ProviderInstanceId.make("antigravity_max_antigravity"),
    driverKind: ProviderDriverKind.make("antigravity"),
    model: "gemini-4-neon",
    label: "4 Neon",
    fullLabel: "Gemini 4 Neon",
    providerDisplayName: "Max Antigravity",
    showInstanceBadge: true,
    isSelected: true,
    isFavorite: true,
    isUnavailable: false,
  },
  {
    key: "claudeAgent:claude-opus-5-5",
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driverKind: ProviderDriverKind.make("claudeAgent"),
    model: "claude-opus-5-5",
    label: "Opus 5.5",
    fullLabel: "Claude Opus 5.5",
    providerDisplayName: "Claude",
    showInstanceBadge: false,
    isSelected: false,
    isFavorite: true,
    isUnavailable: false,
  },
];

function Harness(props: {
  onSelectModel: (instanceId: ProviderInstanceId, model: string) => void;
  onToggleModel: (instanceId: ProviderInstanceId, model: string) => void;
}) {
  const [options, setOptions] = useState<ReadonlyArray<ProviderOptionSelection>>([]);
  const traits: TraitsSelectionInput = {
    provider: ProviderDriverKind.make("antigravity"),
    instanceId: ProviderInstanceId.make("antigravity_max_antigravity"),
    models: [neonModel],
    model: "gemini-4-neon",
    modelOptions: options,
    onModelOptionsChange: (next) => setOptions(next ?? []),
  };
  return (
    <div>
      <textarea aria-label="Prompt" />
      <InlineComposerEffortControl traits={traits} />
      <DraftModelPillStrip
        pills={pills}
        multipleModelsEnabled
        onSelectModel={props.onSelectModel}
        onToggleModel={props.onToggleModel}
        pickerTrigger={
          <button type="button" data-draft-model-all-trigger="true">
            All
          </button>
        }
      />
    </div>
  );
}

it("switches models and effort inline without stealing focus from the composer input", async () => {
  const onSelectModel = vi.fn();
  const onToggleModel = vi.fn();
  await using screen = await render(
    <Harness onSelectModel={onSelectModel} onToggleModel={onToggleModel} />,
    { router: false },
  );

  const editor = screen.getByRole("textbox", { name: "Prompt" });
  await userEvent.click(editor);
  await expect.element(editor).toHaveFocus();

  const opusPill = screen.getByRole("button", { name: "Claude Opus 5.5 · Claude" });
  await userEvent.click(opusPill);
  expect(onSelectModel).toHaveBeenCalledWith("claudeAgent", "claude-opus-5-5");
  await expect.element(editor).toHaveFocus();

  const xHighEffort = screen.getByRole("radio", { name: "xHigh" });
  await userEvent.click(xHighEffort);
  await expect.element(xHighEffort).toHaveAttribute("aria-checked", "true");
  await expect.element(editor).toHaveFocus();

  await expect.element(screen.getByRole("button", { name: "All" })).toBeVisible();
});
