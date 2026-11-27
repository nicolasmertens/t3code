import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  type LocalApi,
  ProjectId,
  ProviderInstanceId,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { fakeTimers, render } from "../../test/render";
import { makeThreadFixture } from "../test-fixtures";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useNowMinute } from "../hooks/useNowMinute";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { readMoveThreadProjectTargets, useThreadActions } from "../hooks/useThreadActions";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { readLocalApi } from "../localApi";
import { useProjects, useQuietThreadShells, useServerConfigs } from "../state/entities";
import { useConnectedEnvironmentIds, usePrimaryEnvironmentId } from "../state/environments";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { useUiStateStore } from "../uiStateStore";
import type { Project } from "../types";
import Sidebar from "./Sidebar";
import { SidebarProvider } from "./ui/sidebar";

vi.mock("../state/entities", { spy: true });
vi.mock("../state/environments", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock("../hooks/useNowMinute", { spy: true });
vi.mock("../hooks/useThreadActions", { spy: true });
vi.mock("../hooks/useThreadRouteTarget", { spy: true });
vi.mock("../localApi", { spy: true });
vi.mock("../state/session", { spy: true });
vi.mock("../state/use-atom-command", { spy: true });
vi.mock("../commandPaletteBus", () => ({
  openCommandPalette: vi.fn(),
  isCommandPaletteOpen: () => false,
}));
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

const ENV = EnvironmentId.make("local");
const SCRATCH_ROOT = "/tmp/t3-scratch";

function makeProject(id: string, title: string, overrides: Partial<Project> = {}): Project {
  return {
    id: ProjectId.make(id),
    environmentId: ENV,
    title,
    workspaceRoot: `/projects/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    ...overrides,
  };
}

function setupSidebarMocks(
  stack: DisposableStack,
  projects: Project[],
  threads: EnvironmentThreadShell[],
  routeThread: EnvironmentThreadShell,
) {
  const prevSettings = getClientSettings();
  const prevUiState = useUiStateStore.getState();
  stack.defer(() => __setClientSettingsForTests(prevSettings));
  stack.defer(() => useUiStateStore.setState(prevUiState, true));
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  useUiStateStore.setState({
    ...prevUiState,
    projectExpandedById: {},
    sidebarProjectScopeKeys: [],
    sidebarGroupMode: null,
    sidebarUrgencyOrder: true,
    sidebarAutoCollapseDone: false,
    sidebarStatusGroupExpandedById: {},
    sidebarShelfFolderExpandedById: {},
  });

  const moveMock = vi.fn(async () => AsyncResult.success(undefined));
  const prevMoveTargets = vi.mocked(readMoveThreadProjectTargets).getMockImplementation();
  stack.defer(() => {
    if (prevMoveTargets) {
      vi.mocked(readMoveThreadProjectTargets).mockImplementation(prevMoveTargets);
    } else {
      vi.mocked(readMoveThreadProjectTargets).mockReset();
    }
  });
  vi.mocked(readMoveThreadProjectTargets).mockReturnValue(
    projects
      .filter((project) => !project.isScratch)
      .map((project) => ({ id: project.id, name: project.title })),
  );
  vi.mocked(useNowMinute).mockReturnValue("2026-03-10T12:00");
  vi.mocked(usePrimaryEnvironmentId).mockReturnValue(ENV);
  vi.mocked(useConnectedEnvironmentIds).mockReturnValue([ENV]);
  vi.mocked(useProjects).mockReturnValue(projects);
  vi.mocked(useQuietThreadShells).mockReturnValue(threads);
  vi.mocked(readEnvironmentScope).mockReturnValue(true);
  vi.mocked(useEnvironmentScope).mockReturnValue(true);
  vi.mocked(useAtomCommand).mockReturnValue(moveMock as never);
  vi.mocked(useServerConfigs).mockReturnValue(
    new Map([
      [
        ENV,
        {
          scratchWorkspaceRoot: SCRATCH_ROOT,
          shellThreadFamilies: false,
          environment: { capabilities: { threadProjectMove: true } },
        } as unknown as EnvironmentServerConfig,
      ],
    ]),
  );
  const routeRef = scopeThreadRef(ENV, routeThread.id);
  vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: routeRef });
  vi.mocked(useHandleNewThread).mockReturnValue({
    activeDraftThread: null,
    activeThread: routeThread,
    defaultProjectRef: scopeProjectRef(ENV, projects[0]!.id),
    defaultProjectFallbackReady: true,
    handleNewThread: vi.fn().mockResolvedValue(null),
    routeDraftId: null,
    routeThreadRef: routeRef,
  });

  return { moveMock };
}

describe("sidebar queue grouping and triage", () => {
  it("switches between Flat, By project, and By status via header menu and g p chord, with triage chips and rollups", async () => {
    using stack = new DisposableStack();
    const fleet = makeProject("fleet", "Fleet Architecture");
    const godwit = makeProject("godwit", "GodWit Mail");
    const scratch = makeProject("scratch", "No project", {
      workspaceRoot: SCRATCH_ROOT,
      isScratch: true,
    });

    const latestCompletedRun = {
      runId: "run-1" as never,
      status: "completed" as const,
      requestedAt: "2026-03-10T10:00:00.000Z",
      startedAt: "2026-03-10T10:00:05.000Z",
      completedAt: "2026-03-10T10:05:00.000Z",
      assistantMessageId: null,
    };

    const completedRuntime = {
      status: "completed" as const,
      activeRunId: null,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerName: "Codex",
      lastError: null,
      updatedAt: "2026-03-10T10:05:00.000Z",
    };

    const pinnedThread = makeThreadFixture({
      environmentId: ENV,
      id: ThreadId.make("t-pinned"),
      projectId: scratch.id,
      title: "Pinned HeyGen Ads",
      pinnedAt: "2026-03-10T09:00:00.000Z",
      latestRun: latestCompletedRun,
      runtime: completedRuntime,
      lastVisitedAt: "2026-03-10T10:06:00.000Z",
    });
    const limitedThread = makeThreadFixture({
      environmentId: ENV,
      id: ThreadId.make("t-limited"),
      projectId: fleet.id,
      title: "Fleet Storage Cutover",
      latestRun: latestCompletedRun,
      lastVisitedAt: "2026-03-10T10:06:00.000Z",
      runtime: {
        status: "failed",
        activeRunId: null,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerName: "Codex",
        lastError: "Quota reached",
        lastErrorClass: "usage_limit",
        updatedAt: "2026-03-10T10:05:00.000Z",
      },
    });
    const doneThread = makeThreadFixture({
      environmentId: ENV,
      id: ThreadId.make("t-done"),
      projectId: godwit.id,
      title: "JMAP Integration Audit",
      latestRun: latestCompletedRun,
      runtime: completedRuntime,
      lastVisitedAt: "2026-03-10T10:04:00.000Z",
    });
    const scratchThread = makeThreadFixture({
      environmentId: ENV,
      id: ThreadId.make("t-scratch"),
      projectId: scratch.id,
      title: "MRTNS books audit",
      latestRun: latestCompletedRun,
      runtime: completedRuntime,
      lastVisitedAt: "2026-03-10T10:06:00.000Z",
    });

    setupSidebarMocks(
      stack,
      [godwit, fleet, scratch],
      [pinnedThread, limitedThread, doneThread, scratchThread],
      scratchThread,
    );

    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
      { router: `/local/${scratchThread.id}` },
    );

    // Starts in Flat mode by default: no project folders or triage filter bar.
    expect(screen.container.querySelector('[data-testid="sidebar-project-folder"]')).toBeNull();
    expect(screen.container.querySelector('[data-testid="sidebar-triage-filters"]')).toBeNull();

    // Press "g" then "p" to toggle into By project grouped mode.
    await userEvent.keyboard("g");
    await userEvent.keyboard("p");

    await expect.element(screen.getByTestId("sidebar-triage-filters")).toBeVisible();
    await expect.element(screen.getByTestId("sidebar-pinned-strip")).toBeVisible();
    await expect.element(screen.getByText("Pinned HeyGen Ads")).toBeVisible();

    // Urgency order puts Fleet (Limited) before GodWit (Done-only) and pins quiet No project at bottom.
    const folderTexts = Array.from(
      screen.container.querySelectorAll('[data-testid="sidebar-project-folder"]'),
    ).map((el) => el.textContent ?? "");
    expect(folderTexts[0]).toContain("Fleet Architecture");
    expect(folderTexts[1]).toContain("GodWit Mail");
    expect(folderTexts[2]).toContain("No project");

    // Collapsing Fleet surfaces the attention rollup pill ("1 !").
    const fleetBtn = screen.getByRole("button", { name: /^Fleet Architecture/ });
    await userEvent.click(fleetBtn);
    await expect.element(screen.getByTestId("sidebar-folder-rollup-attention")).toBeVisible();
    await expect
      .element(screen.getByTestId("sidebar-folder-rollup-attention"))
      .toHaveTextContent("1 !");

    // Clicking the Attention triage chip filters down to only the attention thread.
    await userEvent.click(screen.getByTestId("sidebar-triage-chip-attention"));
    expect(screen.container.querySelectorAll('[data-testid="sidebar-project-folder"]').length).toBe(
      1,
    );

    // Reset filter by clicking Attention again.
    await userEvent.click(screen.getByTestId("sidebar-triage-chip-attention"));
    expect(screen.container.querySelectorAll('[data-testid="sidebar-project-folder"]').length).toBe(
      3,
    );

    // Switch to By status via header group mode menu.
    await userEvent.click(screen.getByTestId("sidebar-group-mode-trigger"));
    await userEvent.click(page.getByRole("menuitemradio", { name: /By status/ }));

    await expect.element(screen.getByTestId("sidebar-status-group-attention")).toBeVisible();
    await expect.element(screen.getByTestId("sidebar-status-group-active")).toBeVisible();
    await expect.element(screen.getByTestId("sidebar-status-group-done")).toBeVisible();

    await userEvent.keyboard("{Escape}");
    await expect
      .element(page.getByRole("menuitemradio", { name: /By status/ }))
      .not.toBeInTheDocument();

    // Toggle back to Flat via g p chord.
    await userEvent.keyboard("g");
    await userEvent.keyboard("p");
    await vi.waitFor(() =>
      expect(
        screen.container.querySelector('[data-testid="sidebar-status-group-attention"]'),
      ).toBeNull(),
    );
  });

  it("opens quick-assign via m shortcut and Organize popover for No project threads", async () => {
    using stack = new DisposableStack();
    const humble = makeProject("humble", "Humble Tools");
    const scratch = makeProject("scratch", "No project", {
      workspaceRoot: SCRATCH_ROOT,
      isScratch: true,
    });
    const scratchThread = makeThreadFixture({
      environmentId: ENV,
      id: ThreadId.make("t-scratch"),
      projectId: scratch.id,
      title: "Humble Tools Funnels",
    });

    const { moveMock } = setupSidebarMocks(
      stack,
      [humble, scratch],
      [scratchThread],
      scratchThread,
    );
    useUiStateStore.getState().setSidebarGroupMode("project");

    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
      { router: `/local/${scratchThread.id}` },
    );

    // Click Organize on No project header to open the organize dialog.
    await expect.element(screen.getByTestId("sidebar-organize-no-project")).toBeVisible();
    await userEvent.click(screen.getByTestId("sidebar-organize-no-project"));
    await expect.element(page.getByText("Organize No project threads")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByText("Organize No project threads")).not.toBeInTheDocument();

    // Press "m" to open the quick Move thread to project dialog and pick Humble Tools.
    await userEvent.keyboard("m");
    await expect.element(page.getByText("Move thread to project")).toBeVisible();
    await userEvent.click(page.getByTestId(`sidebar-move-target-${humble.id}`));

    await vi.waitFor(() =>
      expect(moveMock).toHaveBeenCalledWith({
        environmentId: ENV,
        input: { threadId: scratchThread.id, projectId: humble.id },
      }),
    );
  });

  it("folds working threads into the bottom Working shelf in By project mode and groups Working, Snoozed, and Settled by project", async () => {
    using stack = new DisposableStack();
    for (const key of [
      "t3code:sidebar:working-expanded",
      "t3code:sidebar:snoozed-expanded",
      "t3code:sidebar:settled-expanded",
    ]) {
      const previous = localStorage.getItem(key);
      stack.defer(() => {
        if (previous === null) localStorage.removeItem(key);
        else localStorage.setItem(key, previous);
      });
      localStorage.setItem(key, "false");
    }

    const fleet = makeProject("fleet", "Fleet Architecture");
    const godwit = makeProject("godwit", "GodWit Mail");

    const latestCompletedRun = {
      runId: "run-1" as never,
      status: "completed" as const,
      requestedAt: "2026-03-10T10:00:00.000Z",
      startedAt: "2026-03-10T10:00:05.000Z",
      completedAt: "2026-03-10T10:05:00.000Z",
      assistantMessageId: null,
    };

    const completedRuntime = {
      status: "completed" as const,
      activeRunId: null,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerName: "Codex",
      lastError: null,
      updatedAt: "2026-03-10T10:05:00.000Z",
    };

    const activeThread = makeThreadFixture({
      environmentId: ENV,
      id: ThreadId.make("t-active"),
      projectId: fleet.id,
      title: "Idle Fleet Thread",
      latestRun: latestCompletedRun,
      runtime: completedRuntime,
      lastVisitedAt: "2026-03-10T10:06:00.000Z",
    });
    const workingFleet = makeThreadFixture({
      environmentId: ENV,
      id: ThreadId.make("t-working-fleet"),
      projectId: fleet.id,
      title: "Working Fleet Task",
      runtime: {
        status: "running",
        activeRunId: null,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerName: "Codex",
        lastError: null,
        updatedAt: "2026-03-10T11:30:00.000Z",
      },
    });
    const workingGodwit = makeThreadFixture({
      environmentId: ENV,
      id: ThreadId.make("t-working-godwit"),
      projectId: godwit.id,
      title: "Working GodWit Task",
      runtime: {
        status: "running",
        activeRunId: null,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerName: "Codex",
        lastError: null,
        updatedAt: "2026-03-10T11:31:00.000Z",
      },
    });
    const snoozedGodwit = makeThreadFixture({
      environmentId: ENV,
      id: ThreadId.make("t-snoozed-godwit"),
      projectId: godwit.id,
      title: "Snoozed GodWit Task",
      snoozedAt: "2026-03-10T11:00:00.000Z",
      snoozedUntil: "2099-03-10T15:00:00.000Z",
    });
    const settledFleet = makeThreadFixture({
      environmentId: ENV,
      id: ThreadId.make("t-settled-fleet"),
      projectId: fleet.id,
      title: "Settled Fleet Task",
      settledOverride: "settled",
      settledAt: "2026-03-10T10:30:00.000Z",
      latestRun: latestCompletedRun,
      runtime: completedRuntime,
      lastVisitedAt: "2026-03-10T10:04:00.000Z",
    });

    setupSidebarMocks(
      stack,
      [fleet, godwit],
      [activeThread, workingFleet, workingGodwit, snoozedGodwit, settledFleet],
      activeThread,
    );
    __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, sidebarWorkingShelfEnabled: true });
    useUiStateStore.getState().setSidebarGroupMode("project");

    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
      { router: `/local/${activeThread.id}` },
    );

    // Working shelf appears at the bottom in By project mode and hides working tasks until expanded.
    const workingHeader = screen.getByTestId("sidebar-working-shelf-toggle");
    await expect.element(workingHeader).toBeVisible();
    expect(screen.container.textContent).not.toContain("Working Fleet Task");

    // Expand Working, Snoozed, and Settled shelves.
    await userEvent.click(workingHeader);
    await userEvent.click(screen.getByTestId("sidebar-snoozed-shelf-toggle"));
    await userEvent.click(screen.getByTestId("sidebar-settled-shelf-toggle"));

    // All three shelves group their threads under per-project folders.
    await expect.element(screen.getByText("Working Fleet Task")).toBeVisible();
    await expect.element(screen.getByText("Working GodWit Task")).toBeVisible();
    await expect.element(screen.getByText("Snoozed GodWit Task")).toBeVisible();
    await expect.element(screen.getByText("Settled Fleet Task")).toBeVisible();

    expect(
      screen.container.querySelectorAll('[data-testid="sidebar-working-project-folder"]').length,
    ).toBe(2);
    expect(
      screen.container.querySelectorAll('[data-testid="sidebar-snoozed-project-folder"]').length,
    ).toBe(1);
    expect(
      screen.container.querySelectorAll('[data-testid="sidebar-settled-project-folder"]').length,
    ).toBe(1);

    // Collapsing Fleet inside Working hides Working Fleet Task while leaving the top Fleet folder open.
    const workingFleetFolderBtn = Array.from(
      screen.container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="sidebar-working-project-folder"] button',
      ),
    ).find((btn) => btn.textContent?.includes("Fleet Architecture"));
    expect(workingFleetFolderBtn).toBeDefined();
    await userEvent.click(workingFleetFolderBtn!);
    await vi.waitFor(() =>
      expect(screen.container.textContent).not.toContain("Working Fleet Task"),
    );
    await expect.element(screen.getByText("Idle Fleet Thread")).toBeVisible();

    // Toggling Working section off in the group menu moves working tasks back into top project folders.
    await userEvent.click(screen.getByTestId("sidebar-group-mode-trigger"));
    await userEvent.click(page.getByRole("menuitemcheckbox", { name: /Working section/ }));
    await expect.element(screen.getByText("Working Fleet Task")).toBeVisible();
    await vi.waitFor(() =>
      expect(screen.container.querySelector('[data-testid="sidebar-working-header"]')).toBeNull(),
    );
  });
});

function mockProjectSnoozeActions(stack: DisposableStack) {
  const snoozeThread = vi.fn(async (_target: ScopedThreadRef, _snoozedUntil: string) =>
    AsyncResult.success({ sequence: 1 }),
  );
  const unsnoozeThread = vi.fn(async (_target: ScopedThreadRef) =>
    AsyncResult.success({ sequence: 1 }),
  );
  const prevUseThreadActions = vi.mocked(useThreadActions).getMockImplementation();
  stack.defer(() => {
    if (prevUseThreadActions) {
      vi.mocked(useThreadActions).mockImplementation(prevUseThreadActions);
    }
  });
  vi.mocked(useThreadActions).mockImplementation(() => ({
    ...(prevUseThreadActions
      ? prevUseThreadActions()
      : ({} as ReturnType<typeof useThreadActions>)),
    snoozeThread,
    unsnoozeThread,
  }));
  return { snoozeThread, unsnoozeThread };
}

function mockSidebarContextMenu(stack: DisposableStack, selectedId: string | null = null) {
  const show = vi.fn().mockResolvedValue(selectedId);
  const prevReadLocalApi = vi.mocked(readLocalApi).getMockImplementation();
  stack.defer(() => {
    if (prevReadLocalApi) {
      vi.mocked(readLocalApi).mockImplementation(prevReadLocalApi);
    }
  });
  vi.mocked(readLocalApi).mockReturnValue({ contextMenu: { show } } as unknown as LocalApi);
  return show;
}

describe("sidebar project folder snooze and wake", () => {
  it("snoozes a collapsed project folder via hover SnoozePopover Tomorrow", async () => {
    using stack = new DisposableStack();
    const fleet = makeProject("fleet", "Fleet");
    const mubo = makeProject("mubo", "Mubo");
    const routeThread = makeThreadFixture({
      environmentId: ENV,
      id: ThreadId.make("t-fleet"),
      projectId: fleet.id,
      title: "Fleet Task",
      latestUserMessageAt: "2026-03-10T11:55:00.000Z",
    });
    const mubo1 = makeThreadFixture({
      environmentId: ENV,
      id: ThreadId.make("t-mubo-1"),
      projectId: mubo.id,
      title: "Mubo One",
      latestUserMessageAt: "2026-03-10T11:50:00.000Z",
    });
    const mubo2 = makeThreadFixture({
      environmentId: ENV,
      id: ThreadId.make("t-mubo-2"),
      projectId: mubo.id,
      title: "Mubo Two",
      latestUserMessageAt: "2026-03-10T11:45:00.000Z",
    });

    setupSidebarMocks(stack, [fleet, mubo], [routeThread, mubo1, mubo2], routeThread);
    const { snoozeThread } = mockProjectSnoozeActions(stack);
    useUiStateStore.setState({ sidebarGroupMode: "project" });

    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );

    const muboFolder = screen
      .getByTestId("sidebar-project-folder")
      .filter({ hasText: "Mubo" })
      .first();
    await expect.element(muboFolder).toBeVisible();
    // Collapse Mubo so its threads are hidden, then hover its header snooze button.
    const muboToggle = muboFolder.getByRole("button", { name: /^Mubo/ });
    await userEvent.click(muboToggle);
    await expect.element(muboToggle).toHaveAttribute("aria-expanded", "false");
    await vi.waitFor(() => expect(screen.container.textContent).not.toContain("Mubo One"));

    await userEvent.hover(muboFolder);
    await userEvent.click(muboFolder.getByTestId("sidebar-project-folder-snooze"));
    await expect
      .element(page.getByRole("tab", { name: "Interval" }))
      .toHaveAttribute("aria-selected", "true");
    await userEvent.click(page.getByRole("button", { name: /Tomorrow/ }));

    await vi.waitFor(() => expect(snoozeThread).toHaveBeenCalledTimes(2));
    const snoozedIds = snoozeThread.mock.calls.map(([ref]) => ref.threadId);
    expect(snoozedIds).toEqual(expect.arrayContaining([mubo1.id, mubo2.id]));
  });

  it("snoozes an expanded project folder via hover SnoozePopover", async () => {
    using stack = new DisposableStack();
    using _timers = fakeTimers({ now: new Date("2026-03-10T12:00:00.000Z") });
    const fleet = makeProject("fleet", "Fleet");
    const mubo = makeProject("mubo", "Mubo");
    const routeThread = makeThreadFixture({
      environmentId: ENV,
      id: ThreadId.make("t-fleet"),
      projectId: fleet.id,
      title: "Fleet Task",
      latestUserMessageAt: "2026-03-10T11:55:00.000Z",
    });
    const mubo1 = makeThreadFixture({
      environmentId: ENV,
      id: ThreadId.make("t-mubo-exp-1"),
      projectId: mubo.id,
      title: "Expanded Mubo One",
      latestUserMessageAt: "2026-03-10T11:50:00.000Z",
    });

    setupSidebarMocks(stack, [fleet, mubo], [routeThread, mubo1], routeThread);
    const { snoozeThread } = mockProjectSnoozeActions(stack);
    useUiStateStore.setState({ sidebarGroupMode: "project" });

    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );

    await expect.element(screen.getByText("Expanded Mubo One")).toBeVisible();
    const muboFolder = screen
      .getByTestId("sidebar-project-folder")
      .filter({ hasText: "Mubo" })
      .first();
    await userEvent.hover(muboFolder);
    await userEvent.click(muboFolder.getByTestId("sidebar-project-folder-snooze"));
    await userEvent.click(page.getByRole("button", { name: /Tomorrow/ }));

    await vi.waitFor(() => expect(snoozeThread).toHaveBeenCalledTimes(1));
    expect(snoozeThread.mock.calls[0]?.[0]).toEqual(scopeThreadRef(ENV, mubo1.id));
  });

  it("snoozes eligible threads via context menu while skipping approval-blocked threads", async () => {
    using stack = new DisposableStack();
    using _timers = fakeTimers({ now: new Date("2026-03-10T12:00:00.000Z") });
    const fleet = makeProject("fleet", "Fleet");
    const mubo = makeProject("mubo", "Mubo");
    const routeThread = makeThreadFixture({
      environmentId: ENV,
      id: ThreadId.make("t-fleet"),
      projectId: fleet.id,
      title: "Fleet Task",
    });
    const eligible = makeThreadFixture({
      environmentId: ENV,
      id: ThreadId.make("t-mubo-ok"),
      projectId: mubo.id,
      title: "Mubo Eligible",
      latestUserMessageAt: "2026-03-10T11:50:00.000Z",
    });
    const blocked = makeThreadFixture({
      environmentId: ENV,
      id: ThreadId.make("t-mubo-blocked"),
      projectId: mubo.id,
      title: "Mubo Approval",
      hasPendingApprovals: true,
      latestUserMessageAt: "2026-03-10T11:52:00.000Z",
    });

    setupSidebarMocks(stack, [fleet, mubo], [routeThread, eligible, blocked], routeThread);
    const { snoozeThread } = mockProjectSnoozeActions(stack);
    const showMenu = mockSidebarContextMenu(stack, "snooze-project:at:tomorrow:09:00");
    useUiStateStore.setState({ sidebarGroupMode: "project" });

    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );

    const muboHeader = screen
      .getByTestId("sidebar-project-folder")
      .filter({ hasText: "Mubo" })
      .getByRole("button", { name: /^Mubo/ });
    await userEvent.click(muboHeader, { button: "right" });

    await vi.waitFor(() => expect(showMenu).toHaveBeenCalledTimes(1));
    const menuItems = showMenu.mock.calls[0]?.[0] as ReadonlyArray<{
      readonly id: string;
      readonly label: string;
    }>;
    expect(menuItems.find((item) => item.id === "snooze-project")?.label).toBe(
      "Snooze project (1)",
    );

    await vi.waitFor(() => expect(snoozeThread).toHaveBeenCalledTimes(1));
    expect(snoozeThread.mock.calls[0]?.[0]).toEqual(scopeThreadRef(ENV, eligible.id));
  });

  it("wakes all snoozed threads in a collapsed Snoozed project via hover Wake button and context menu", async () => {
    using stack = new DisposableStack();
    const fleet = makeProject("fleet", "Fleet");
    const mubo = makeProject("mubo", "Mubo");
    const routeThread = makeThreadFixture({
      environmentId: ENV,
      id: ThreadId.make("t-fleet"),
      projectId: fleet.id,
      title: "Fleet Task",
    });
    const snoozed1 = makeThreadFixture({
      environmentId: ENV,
      id: ThreadId.make("t-mubo-snoozed-1"),
      projectId: mubo.id,
      title: "Snoozed Mubo 1",
      snoozedAt: "2026-03-10T11:00:00.000Z",
      snoozedUntil: "2099-03-10T15:00:00.000Z",
    });
    const snoozed2 = makeThreadFixture({
      environmentId: ENV,
      id: ThreadId.make("t-mubo-snoozed-2"),
      projectId: mubo.id,
      title: "Snoozed Mubo 2",
      snoozedAt: "2026-03-10T11:00:00.000Z",
      snoozedUntil: "2099-03-10T15:00:00.000Z",
    });

    setupSidebarMocks(stack, [fleet, mubo], [routeThread, snoozed1, snoozed2], routeThread);
    const { unsnoozeThread } = mockProjectSnoozeActions(stack);
    const showMenu = mockSidebarContextMenu(stack, "wake-project");
    useUiStateStore.setState({ sidebarGroupMode: "project" });

    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );

    await userEvent.click(screen.getByTestId("sidebar-snoozed-shelf-toggle"));
    const snoozedMubo = screen
      .getByTestId("sidebar-snoozed-project-folder")
      .filter({ hasText: "Mubo" })
      .first();
    await expect.element(snoozedMubo).toBeVisible();
    // Collapse the Snoozed Mubo sub-folder and wake via the hover button.
    const snoozedMuboToggle = snoozedMubo.getByRole("button", { name: /^Mubo/ });
    await userEvent.click(snoozedMuboToggle);
    await expect.element(snoozedMuboToggle).toHaveAttribute("aria-expanded", "false");
    await vi.waitFor(() => expect(screen.container.textContent).not.toContain("Snoozed Mubo 1"));

    await userEvent.hover(snoozedMubo);
    await userEvent.click(snoozedMubo.getByTestId("sidebar-shelf-folder-wake"));
    await vi.waitFor(() => expect(unsnoozeThread).toHaveBeenCalledTimes(2));

    // Context menu on the Snoozed Mubo sub-folder also exposes Wake project (2).
    await userEvent.click(snoozedMuboToggle, { button: "right" });
    await vi.waitFor(() => expect(showMenu).toHaveBeenCalledTimes(1));
    const menuItems = showMenu.mock.calls[0]?.[0] as ReadonlyArray<{
      readonly id: string;
      readonly label: string;
    }>;
    expect(menuItems.find((item) => item.id === "wake-project")?.label).toBe("Wake project (2)");
    await vi.waitFor(() => expect(unsnoozeThread).toHaveBeenCalledTimes(4));
  });
});
