import { describe, expect, it } from "vite-plus/test";

import {
  defaultRepositoryCloneDestination,
  findProjectFolderForRepository,
  resolveRepositoryCloneTarget,
  resolveTrackedFolderInput,
  trackedFolderDisplayPath,
  trackedFolderForClone,
} from "./trackedFolders.logic";

describe("trackedFolderDisplayPath", () => {
  it.each([
    ["/work/app/api", "/work/app", "api"],
    ["/work/app/packages/web", "/work/app/", "packages/web"],
    ["/work/other", "/work/app", "/work/other"],
    ["/work/app-two", "/work/app", "/work/app-two"],
    ["C:\\Work\\App\\api", "c:\\work\\app", "api"],
  ])("shows %s under %s as %s", (path, root, expected) => {
    expect(trackedFolderDisplayPath(path, root)).toBe(expected);
  });
});

describe("resolveTrackedFolderInput", () => {
  it.each([
    [
      "an absolute path that is not listed",
      { query: "/srv/repos/tools/", listedDirectoryPath: null, exactEntryPath: null },
      { path: "/srv/repos/tools", name: "tools" },
    ],
    [
      "a listed directory, which resolves the home prefix",
      { query: "~/code/", listedDirectoryPath: "/home/me/code", exactEntryPath: null },
      { path: "/home/me/code", name: "code" },
    ],
    [
      "an exact entry of the listed directory",
      {
        query: "~/code/tools",
        listedDirectoryPath: "/home/me/code",
        exactEntryPath: "/home/me/code/tools",
      },
      { path: "/home/me/code/tools", name: "tools" },
    ],
    [
      "a directory name longer than a folder name may be",
      {
        query: `/srv/${"n".repeat(127)} ${"x".repeat(40)}`,
        listedDirectoryPath: null,
        exactEntryPath: null,
      },
      { path: `/srv/${"n".repeat(127)} ${"x".repeat(40)}`, name: "n".repeat(127) },
    ],
  ])("resolves %s", (_label, input, expected) => {
    expect(resolveTrackedFolderInput(input)).toEqual(expected);
  });

  it.each(["", "   ", "~/code/too", "relative/path"])("rejects %j without a listing", (query) => {
    expect(
      resolveTrackedFolderInput({ query, listedDirectoryPath: null, exactEntryPath: null }),
    ).toBeNull();
  });
});

describe("findProjectFolderForRepository", () => {
  const project = {
    workspaceRoot: "/code/humble-tools",
    projectFolders: ["/code/humble-onboarding", "/notes/Humble-Search"],
  };

  it.each([
    ["the project folder", "acme/humble-tools", "/code/humble-tools"],
    ["a tracked folder", "acme/humble-onboarding", "/code/humble-onboarding"],
    ["a folder whose name differs only in case", "acme/humble-search", "/notes/Humble-Search"],
    ["no folder", "acme/site-routes", null],
  ])("finds %s", (_label, nameWithOwner, expected) => {
    expect(findProjectFolderForRepository({ ...project, nameWithOwner })).toBe(expected);
  });
});

describe("defaultRepositoryCloneDestination", () => {
  it("clones next to the project folder", () => {
    expect(
      defaultRepositoryCloneDestination({
        nameWithOwner: "acme/humble-search",
        workspaceRoot: "/home/me/code/humble-tools",
        projectFolders: [],
      }),
    ).toBe("/home/me/code/humble-search");
  });

  it("points at the folder the project already has for that repository", () => {
    expect(
      defaultRepositoryCloneDestination({
        nameWithOwner: "acme/humble-search",
        workspaceRoot: "/home/me/.t3/projects/humble",
        projectFolders: ["/home/me/code/humble-search"],
      }),
    ).toBe("/home/me/code/humble-search");
  });

  it("keeps Windows separators", () => {
    expect(
      defaultRepositoryCloneDestination({
        nameWithOwner: "acme/api",
        workspaceRoot: "C:\\Work\\app",
        projectFolders: [],
      }),
    ).toBe("C:\\Work\\api");
  });
});

describe("resolveRepositoryCloneTarget", () => {
  const project = {
    workspaceRoot: "/code/humble-tools",
    projectFolders: ["/code/humble-onboarding"],
  };

  it.each([
    ["an empty path", "", null, { kind: "invalid" }],
    ["a relative path", "code/humble-search", null, { kind: "invalid" }],
    ["a filesystem root", "/", null, { kind: "invalid" }],
    [
      "the project folder",
      "/code/humble-tools/",
      "/code/humble-tools",
      { kind: "in-project", path: "/code/humble-tools" },
    ],
    [
      "a folder the project tracks",
      "~/code/humble-onboarding",
      "/code/humble-onboarding",
      { kind: "in-project", path: "/code/humble-onboarding" },
    ],
    [
      "a folder already on disk",
      "/code/humble-search",
      "/code/humble-search",
      { kind: "existing", folder: { path: "/code/humble-search", name: "humble-search" } },
    ],
    [
      "a folder that is not there yet",
      "/code/humble-search/",
      null,
      { kind: "new", path: "/code/humble-search" },
    ],
    ["a home path to clone into", "~/code/x", null, { kind: "new", path: "~/code/x" }],
  ])("resolves %s", (_label, destination, exactEntryPath, expected) => {
    expect(resolveRepositoryCloneTarget({ ...project, destination, exactEntryPath })).toEqual(
      expected,
    );
  });
});

describe("trackedFolderForClone", () => {
  it("names the folder after the checkout", () => {
    expect(trackedFolderForClone("/home/me/code/humble-search/")).toEqual({
      path: "/home/me/code/humble-search",
      name: "humble-search",
    });
  });
});
