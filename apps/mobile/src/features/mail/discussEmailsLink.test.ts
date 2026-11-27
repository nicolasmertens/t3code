import type { NavigationState, PartialState } from "@react-navigation/native";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./discussEmails", () => ({
  launchDiscussEmails: vi.fn(),
}));
vi.mock("../../lib/rootNavigation", () => ({ rootNavigationRef: {} }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/workspace", () => ({ workspaceStateAtom: {} }));

import {
  isDiscussEmailsPath,
  parseDiscussEmailsPath,
  takeDiscussEmailsLink,
} from "./discussEmailsLink";

describe("parseDiscussEmailsPath", () => {
  it("parses /new/discuss-emails with optional slashes, query options, and hash", () => {
    expect(parseDiscussEmailsPath("/new/discuss-emails")).toEqual({
      draftOnly: false,
      scope: "core",
    });
    expect(parseDiscussEmailsPath("new/discuss-emails/")).toEqual({
      draftOnly: false,
      scope: "core",
    });
    expect(parseDiscussEmailsPath("/new/discuss-emails?draft=1&scope=all#top")).toEqual({
      draftOnly: true,
      scope: "all",
    });
    expect(parseDiscussEmailsPath("/new/discuss-emails?draft=true&scope=core")).toEqual({
      draftOnly: true,
      scope: "core",
    });
    expect(isDiscussEmailsPath("/new/discuss-emails")).toBe(true);
  });

  it("rejects unrelated paths", () => {
    for (const path of [
      "",
      "/",
      "/new",
      "/new/scratch",
      "/new/project",
      "/new/discuss-emails/extra",
      "/threads/e/t",
    ]) {
      expect(parseDiscussEmailsPath(path)).toBeNull();
      expect(isDiscussEmailsPath(path)).toBe(false);
    }
  });
});

describe("takeDiscussEmailsLink", () => {
  it("keeps the navigation state intact", () => {
    const state = {
      index: 1,
      routes: [{ name: "Home" }, { name: "NewTaskProject" }],
    } as unknown as PartialState<NavigationState>;
    expect(takeDiscussEmailsLink(state, "/new/discuss-emails")).toBe(state);
    expect(takeDiscussEmailsLink(state, "/new")).toBe(state);
  });
});
