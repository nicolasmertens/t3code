import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, type OrchestrationV2AppThreadLineage } from "@t3tools/contracts";

import type { EnvironmentProject } from "./models.ts";
import { isScratchProject, selectMoveTargetProjects } from "./projects.ts";

function makeProject(input: {
  id: string;
  title: string;
  environmentId?: string;
  pinnedAt?: string | null;
  archivedAt?: string | null;
  workspaceRoot?: string;
  isScratch?: true;
}): EnvironmentProject {
  return {
    id: ProjectId.make(input.id),
    title: input.title,
    environmentId: EnvironmentId.make(input.environmentId ?? "env-1"),
    pinnedAt: input.pinnedAt ?? null,
    archivedAt: input.archivedAt ?? null,
    workspaceRoot: input.workspaceRoot ?? `/projects/${input.id}`,
    ...(input.isScratch ? { isScratch: true as const } : {}),
  } as unknown as EnvironmentProject;
}

const ROOT_LINEAGE: OrchestrationV2AppThreadLineage = {
  parentThreadId: null,
  relationshipToParent: null,
  rootThreadId: "thread-1" as never,
};

describe("isScratchProject", () => {
  it.each([null, undefined])(
    "recognises a loaded scratch project when its environment offers no available root (%s)",
    (scratchWorkspaceRoot) => {
      const project = { workspaceRoot: "/remote/scratch", isScratch: true as const };

      expect(isScratchProject(project, scratchWorkspaceRoot)).toBe(true);
    },
  );
});

describe("selectMoveTargetProjects", () => {
  const thread = {
    environmentId: EnvironmentId.make("env-1"),
    projectId: ProjectId.make("current"),
    lineage: ROOT_LINEAGE,
    delegatedFrom: null,
  };

  it("filters same-environment active non-scratch projects and sorts pinned first", () => {
    const projects: EnvironmentProject[] = [
      makeProject({ id: "zulu", title: "Zulu" }),
      makeProject({ id: "alpha", title: "Alpha" }),
      makeProject({ id: "pin-b", title: "Pin Beta", pinnedAt: "2026-01-02T00:00:00Z" }),
      makeProject({ id: "pin-a", title: "Pin Alpha", pinnedAt: "2026-01-01T00:00:00Z" }),
      makeProject({
        id: "current",
        title: "Current Project",
        pinnedAt: "2026-01-03T00:00:00Z",
      }),
      makeProject({ id: "archived", title: "Archived", archivedAt: "2026-01-01T00:00:00Z" }),
      makeProject({ id: "scratch-flag", title: "No project", isScratch: true }),
      makeProject({ id: "scratch-root", title: "No project", workspaceRoot: "/scratch" }),
      makeProject({ id: "other-env", title: "Other Env", environmentId: "env-2" }),
    ];

    expect(
      selectMoveTargetProjects({
        thread,
        projects,
        scratchWorkspaceRoot: "/scratch",
        supported: true,
      }),
    ).toEqual([
      { id: ProjectId.make("pin-a"), name: "Pin Alpha" },
      { id: ProjectId.make("pin-b"), name: "Pin Beta" },
      { id: ProjectId.make("alpha"), name: "Alpha" },
      { id: ProjectId.make("zulu"), name: "Zulu" },
    ]);
  });

  it("returns empty when unsupported, unlisted, or delegated", () => {
    const projects = [makeProject({ id: "target", title: "Target" })];
    expect(
      selectMoveTargetProjects({
        thread,
        projects,
        scratchWorkspaceRoot: "/scratch",
        supported: false,
      }),
    ).toEqual([]);
    expect(
      selectMoveTargetProjects({
        thread: {
          ...thread,
          lineage: {
            parentThreadId: "parent" as never,
            relationshipToParent: "subagent",
            rootThreadId: "parent" as never,
          },
        },
        projects,
        scratchWorkspaceRoot: "/scratch",
        supported: true,
      }),
    ).toEqual([]);
    expect(
      selectMoveTargetProjects({
        thread: {
          ...thread,
          delegatedFrom: { environmentId: EnvironmentId.make("env-0") } as never,
        },
        projects,
        scratchWorkspaceRoot: "/scratch",
        supported: true,
      }),
    ).toEqual([]);
  });
});
