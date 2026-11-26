import type { Action } from "expo-quick-actions";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-quick-actions", () => ({}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("../../connection/catalog", () => ({}));
vi.mock("../../lib/scopedEntities", () => ({
  scopedProjectKey: (e: string, p: string) => `${e}:${p}`,
}));
vi.mock("../../persistence/imperative", () => ({}));
vi.mock("../../state/atom-registry", () => ({}));
vi.mock("../../state/projects", () => ({ environmentProjects: {} }));
vi.mock("../../state/threads", () => ({ environmentThreadShells: {} }));
vi.mock("./appShortcuts", async () => {
  const actual = await vi.importActual<typeof import("./appShortcuts")>("./appShortcuts");
  return {
    areShortcutActionsEqual: actual.areShortcutActionsEqual,
    withRecentThreadShortcut: actual.withRecentThreadShortcut,
  };
});

import type { RecentThreadShortcut } from "../../persistence/imperative";
import {
  createDeduplicatedQuickActionPublisher,
  createRecentThreadShortcuts,
} from "./appShortcutsRuntime";

const thread = (threadId: string, title = threadId): RecentThreadShortcut => ({
  environmentId: "env",
  threadId,
  title,
});

function setup(load: () => Promise<ReadonlyArray<RecentThreadShortcut>>) {
  const save = vi.fn<(list: ReadonlyArray<RecentThreadShortcut>) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const publish = vi.fn<(list: ReadonlyArray<RecentThreadShortcut>) => Promise<void>>(() =>
    Promise.resolve(),
  );
  return { save, publish, recents: createRecentThreadShortcuts({ load, save, publish }) };
}

describe("createRecentThreadShortcuts", () => {
  it("waits for the persisted list before recording the open thread", async () => {
    const { save, publish, recents } = setup(() => Promise.resolve([thread("old")]));
    recents.recordActiveThread(thread("new"));
    expect(publish).not.toHaveBeenCalled();
    await recents.loaded;
    await recents.saved();
    expect(publish).toHaveBeenLastCalledWith([thread("new"), thread("old")]);
    expect(save).toHaveBeenLastCalledWith([thread("new"), thread("old")]);
  });

  it("does not persist the empty fallback after a failed load", async () => {
    using _warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { save, publish, recents } = setup(() => Promise.reject(new Error("read failed")));
    await recents.loaded;
    await recents.saved();
    expect(publish).toHaveBeenLastCalledWith([]);
    expect(save).not.toHaveBeenCalled();

    recents.recordActiveThread(thread("a"));
    await recents.saved();
    expect(save).toHaveBeenLastCalledWith([thread("a")]);
  });

  it("drops threads of environments that are no longer saved", async () => {
    const gone = { environmentId: "gone", threadId: "b", title: "b" };
    const kept = { environmentId: "kept", threadId: "c", title: "c" };
    const { save, publish, recents } = setup(() => Promise.resolve([thread("a"), gone, kept]));
    recents.retainEnvironments(new Set(["env", "kept"]));
    await recents.loaded;
    expect(publish).toHaveBeenLastCalledWith([thread("a"), kept]);

    recents.retainEnvironments(new Set(["kept"]));
    await recents.saved();
    expect(publish).toHaveBeenLastCalledWith([kept]);
    expect(save).toHaveBeenLastCalledWith([kept]);

    recents.recordActiveThread(thread("a"));
    expect(publish).toHaveBeenLastCalledWith([kept]);
  });

  it("records title changes of the open thread and ignores repeats", async () => {
    const { publish, recents } = setup(() => Promise.resolve([]));
    await recents.loaded;
    recents.recordActiveThread(thread("a", ""));
    recents.recordActiveThread(thread("a", "Named"));
    recents.recordActiveThread(thread("a", "Named"));
    recents.recordActiveThread(null);
    expect(publish.mock.calls.map(([list]) => list)).toEqual([
      [],
      [thread("a", "")],
      [thread("a", "Named")],
    ]);
  });
});

describe("createDeduplicatedQuickActionPublisher", () => {
  const action = (title: string): Action => ({
    id: "quick-scratch",
    title,
    subtitle: "No project",
    icon: "symbol:square.and.pencil",
    params: { href: "/new/scratch" },
  });

  it("skips duplicate publishes and publishes again when actions change or reset", async () => {
    const publish = vi.fn<(actions: Action[]) => Promise<void>>(() => Promise.resolve());
    const publisher = createDeduplicatedQuickActionPublisher(publish);

    await publisher.publish([action("Quick task")]);
    await publisher.publish([action("Quick task")]);
    expect(publish).toHaveBeenCalledTimes(1);

    await publisher.publish([action("Snelle taak")]);
    expect(publish).toHaveBeenCalledTimes(2);

    publisher.reset();
    await publisher.publish([action("Snelle taak")]);
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it("clears the deduplication cache after a failed publish so retries run", async () => {
    using _warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const publish = vi
      .fn<(actions: Action[]) => Promise<void>>()
      .mockRejectedValueOnce(new Error("native bridge failed"))
      .mockResolvedValueOnce(undefined);
    const publisher = createDeduplicatedQuickActionPublisher(publish);

    await publisher.publish([action("Quick task")]);
    await publisher.publish([action("Quick task")]);
    expect(publish).toHaveBeenCalledTimes(2);
  });
});
