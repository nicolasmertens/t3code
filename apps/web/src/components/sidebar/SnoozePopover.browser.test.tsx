import "../../index.css";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { fakeTimers, render } from "../../../test/render";
import { makeThreadFixture } from "../../test-fixtures";
import { readThreadShells } from "../../state/entities";
import { SnoozePopover } from "./SnoozePopover";
import { TooltipProvider } from "../ui/tooltip";

vi.mock("../../state/entities", { spy: true });

const ENV_ID = EnvironmentId.make("local");
const THREAD_ID = ThreadId.make("thread-main");
const FIXED_NOW = new Date(2026, 10, 26, 8, 32, 0);

function Harness(props: {
  readonly onSnooze: (preset: { readonly snoozedUntil: string }) => void;
  readonly hasLinkedPullRequest?: boolean;
  readonly linkedPullRequestLabel?: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <TooltipProvider>
      <SnoozePopover
        open={open}
        onOpenChange={setOpen}
        onSnooze={props.onSnooze}
        timestampFormat="12-hour"
        environmentId={ENV_ID}
        threadId={THREAD_ID}
        hasLinkedPullRequest={props.hasLinkedPullRequest ?? false}
        linkedPullRequestLabel={props.linkedPullRequestLabel ?? null}
      />
    </TooltipProvider>
  );
}

describe("SnoozePopover", () => {
  it("opens on Hours tab by default with 9 duration tiles and commits 3h snooze", async () => {
    using _timers = fakeTimers({ now: FIXED_NOW });
    vi.mocked(readThreadShells).mockReturnValue([]);
    const onSnooze = vi.fn();
    await using screen = await render(<Harness onSnooze={onSnooze} />);

    await userEvent.click(screen.getByRole("button", { name: "Snooze thread" }));
    await expect
      .element(page.getByRole("tab", { name: "Hours" }))
      .toHaveAttribute("aria-selected", "true");

    for (const label of ["15m", "30m", "1h", "2h", "3h", "4h", "6h", "8h", "12h"]) {
      await expect
        .element(page.getByRole("button", { name: new RegExp(`^${label}\\b`) }))
        .toBeVisible();
    }
    await expect.element(page.getByRole("button", { name: "Decrease duration" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Increase duration" })).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: /^3h\b/ }));
    expect(onSnooze).toHaveBeenCalledWith({
      snoozedUntil: new Date(FIXED_NOW.getTime() + 180 * 60_000).toISOString(),
    });
    await expect
      .element(page.getByRole("tablist", { name: "Snooze mode" }))
      .not.toBeInTheDocument();
  });

  it("switches to Interval, updates wake times with Wake at pills, and commits Next Monday", async () => {
    using _timers = fakeTimers({ now: FIXED_NOW });
    vi.mocked(readThreadShells).mockReturnValue([]);
    const onSnooze = vi.fn();
    await using screen = await render(<Harness onSnooze={onSnooze} />);

    await userEvent.click(screen.getByRole("button", { name: "Snooze thread" }));
    await userEvent.click(page.getByRole("tab", { name: "Interval" }));

    await expect
      .element(page.getByRole("button", { name: /Tomorrow/ }))
      .toHaveTextContent("Fri 9:00 AM");
    await userEvent.click(page.getByRole("button", { name: "1 PM" }));
    await expect
      .element(page.getByRole("button", { name: /Tomorrow/ }))
      .toHaveTextContent("Fri 1:00 PM");

    await userEvent.click(page.getByRole("button", { name: /Next Monday/ }));
    expect(onSnooze).toHaveBeenCalledWith({
      snoozedUntil: new Date(2026, 10, 30, 13, 0, 0).toISOString(),
    });
  });

  it("switches to Calendar, selects a future date, and commits via Set", async () => {
    using _timers = fakeTimers({ now: FIXED_NOW });
    vi.mocked(readThreadShells).mockReturnValue([
      makeThreadFixture({
        environmentId: ENV_ID,
        id: ThreadId.make("other-snoozed"),
        snoozedUntil: new Date(2026, 10, 30, 9, 0, 0).toISOString(),
      }),
    ]);
    const onSnooze = vi.fn();
    await using screen = await render(<Harness onSnooze={onSnooze} />);

    await userEvent.click(screen.getByRole("button", { name: "Snooze thread" }));
    await userEvent.click(page.getByRole("tab", { name: "Calendar" }));

    const nextMonthBtn = page.getByRole("button", { name: "Next month" });
    await userEvent.click(nextMonthBtn);
    await userEvent.click(page.getByRole("button", { name: "2026-12-02" }));
    await userEvent.click(page.getByRole("button", { name: "Set" }));

    expect(onSnooze).toHaveBeenCalledWith({
      snoozedUntil: new Date(2026, 11, 2, 9, 0, 0).toISOString(),
    });
  });

  it("switches to Trigger, navigates in-place subviews, and commits fallback snooze", async () => {
    using _timers = fakeTimers({ now: FIXED_NOW });
    vi.mocked(readThreadShells).mockReturnValue([
      makeThreadFixture({
        environmentId: ENV_ID,
        id: ThreadId.make("fleet-thread"),
        title: "Fleet Architecture",
      }),
    ]);
    const onSnooze = vi.fn();
    await using screen = await render(<Harness onSnooze={onSnooze} />);

    await userEvent.click(screen.getByRole("button", { name: "Snooze thread" }));
    await userEvent.click(page.getByRole("tab", { name: "Trigger" }));

    await userEvent.click(page.getByRole("button", { name: /Another thread finishes/ }));
    await expect.element(page.getByRole("button", { name: "Fleet Architecture" })).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Back" }));
    await expect.element(page.getByRole("button", { name: /Next active session/ })).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: /PR checks or review/ }));
    await userEvent.click(page.getByRole("button", { name: "24h" }));
    await userEvent.click(page.getByRole("button", { name: /Snooze \(24h max wait\)/ }));

    expect(onSnooze).toHaveBeenCalledWith({
      snoozedUntil: new Date(FIXED_NOW.getTime() + 24 * 3_600_000).toISOString(),
    });
  });

  it("switches tabs via 1-4 keyboard shortcuts while open", async () => {
    using _timers = fakeTimers({ now: FIXED_NOW });
    vi.mocked(readThreadShells).mockReturnValue([]);
    const onSnooze = vi.fn();
    await using screen = await render(<Harness onSnooze={onSnooze} />);

    await userEvent.click(screen.getByRole("button", { name: "Snooze thread" }));
    await expect
      .element(page.getByRole("tab", { name: "Hours" }))
      .toHaveAttribute("aria-selected", "true");

    await userEvent.keyboard("2");
    await expect
      .element(page.getByRole("tab", { name: "Interval" }))
      .toHaveAttribute("aria-selected", "true");

    await userEvent.keyboard("3");
    await expect
      .element(page.getByRole("tab", { name: "Calendar" }))
      .toHaveAttribute("aria-selected", "true");

    await userEvent.keyboard("4");
    await expect
      .element(page.getByRole("tab", { name: "Trigger" }))
      .toHaveAttribute("aria-selected", "true");

    await userEvent.keyboard("1");
    await expect
      .element(page.getByRole("tab", { name: "Hours" }))
      .toHaveAttribute("aria-selected", "true");
  });
});
