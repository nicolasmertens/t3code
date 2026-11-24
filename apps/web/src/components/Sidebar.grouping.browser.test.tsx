import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { makeThreadFixture } from "../test-fixtures";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useNowMinute } from "../hooks/useNowMinute";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
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
vi.mock("../hooks/useThreadRouteTarget", { spy: true });
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
  });

  const moveMock = vi.fn(async () => AsyncResult.success(undefined));
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

    const pinnedThread = makeThreadFixture({
      environmentId: ENV,
      id: ThreadId.make("t-pinned"),
      projectId: scratch.id,
      title: "Pinned HeyGen Ads",
      pinnedAt: "2026-03-10T09:00:00.000Z",
      latestRun: latestCompletedRun,
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
      lastVisitedAt: "2026-03-10T10:04:00.000Z",
    });
    const scratchThread = makeThreadFixture({
      environmentId: ENV,
      id: ThreadId.make("t-scratch"),
      projectId: scratch.id,
      title: "MRTNS books audit",
      latestRun: latestCompletedRun,
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
    await userEvent.click(screen.getByRole("menuitemradio", { name: /By status/ }));

    await expect.element(screen.getByTestId("sidebar-status-group-attention")).toBeVisible();
    await expect.element(screen.getByTestId("sidebar-status-group-active")).toBeVisible();
    await expect.element(screen.getByTestId("sidebar-status-group-done")).toBeVisible();

    // Toggle back to Flat via g p chord.
    await userEvent.keyboard("g");
    await userEvent.keyboard("p");
    await act(() => {});
    expect(
      screen.container.querySelector('[data-testid="sidebar-status-group-attention"]'),
    ).toBeNull();
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
    await expect.element(screen.getByText("Organize No project threads")).toBeVisible();
    await userEvent.keyboard("{Escape}");

    // Press "m" to open the quick Move thread to project dialog and pick Humble Tools.
    await userEvent.keyboard("m");
    await expect.element(screen.getByText("Move thread to project")).toBeVisible();
    await userEvent.click(screen.getByTestId(`sidebar-move-target-${humble.id}`));

    await vi.waitFor(() =>
      expect(moveMock).toHaveBeenCalledWith({
        environmentId: ENV,
        input: { threadId: scratchThread.id, projectId: humble.id },
      }),
    );
  });
});
