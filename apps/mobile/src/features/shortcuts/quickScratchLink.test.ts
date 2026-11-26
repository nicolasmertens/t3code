import type { NavigationState, PartialState } from "@react-navigation/native";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../lib/rootNavigation", () => ({ rootNavigationRef: {} }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/projects", () => ({ projectEnvironment: {} }));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../../state/threads", () => ({ environmentThreadShells: {} }));
vi.mock("../../state/use-composer-drafts", () => ({}));
vi.mock("../../state/workspace", () => ({ workspaceConnections: {}, workspaceStateAtom: {} }));
vi.mock("../layout/workspace/workspace-detail-selection", () => ({
  selectWorkspaceDetail: vi.fn(),
}));

import { isQuickScratchPath, takeQuickScratchLink } from "./quickScratchLink";

describe("isQuickScratchPath", () => {
  it("matches /new/scratch with optional slashes, query, or hash", () => {
    expect(isQuickScratchPath("/new/scratch")).toBe(true);
    expect(isQuickScratchPath("new/scratch")).toBe(true);
    expect(isQuickScratchPath("/new/scratch/")).toBe(true);
    expect(isQuickScratchPath("/new/scratch?source=shortcut#top")).toBe(true);
  });

  it("rejects other routes", () => {
    for (const path of ["", "/", "/new", "/new/project", "/new/scratch/extra", "/threads/e/t"]) {
      expect(isQuickScratchPath(path)).toBe(false);
    }
  });
});

describe("takeQuickScratchLink", () => {
  it("keeps the navigation state intact", () => {
    const state = {
      index: 1,
      routes: [{ name: "Home" }, { name: "NewTaskProject" }],
    } as unknown as PartialState<NavigationState>;
    expect(takeQuickScratchLink(state, "/new/scratch")).toBe(state);
    expect(takeQuickScratchLink(state, "/new")).toBe(state);
  });
});
