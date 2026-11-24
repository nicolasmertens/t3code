import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => {
  const files = new Map<string, string>();
  const pairEnvironment = vi.fn<
    (pairingUrl: string) => Promise<{
      readonly ok: boolean;
      readonly environmentId?: EnvironmentId;
      readonly error: string | null;
    }>
  >();

  class MockFile {
    readonly key: string;
    constructor(...parts: Array<string | { readonly path?: string }>) {
      this.key = parts
        .map((part) => (typeof part === "string" ? part : (part.path ?? "")))
        .join("/");
    }
    get exists(): boolean {
      return files.has(this.key);
    }
    async text(): Promise<string> {
      const value = files.get(this.key);
      if (value === undefined) throw new Error(`Missing ${this.key}`);
      return value;
    }
    create(): void {
      if (!files.has(this.key)) files.set(this.key, "");
    }
    async write(contents: string): Promise<void> {
      files.set(this.key, contents);
    }
    delete(): void {
      files.delete(this.key);
    }
  }

  return { files, pairEnvironment, MockFile };
});

vi.mock("react-native", () => ({
  AppState: {
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
}));

vi.mock("expo-file-system", () => ({
  File: state.MockFile,
  Paths: { document: "/documents" },
}));

vi.mock("../../state/use-remote-environment-registry", () => ({
  pairEnvironment: state.pairEnvironment,
}));

import {
  BOOTSTRAP_PAIR_FILE,
  BOOTSTRAP_PAIR_RESULT_FILE,
  consumeBootstrapPairing,
} from "./bootstrapPairing";

const INPUT_KEY = `/documents/${BOOTSTRAP_PAIR_FILE}`;
const RESULT_KEY = `/documents/${BOOTSTRAP_PAIR_RESULT_FILE}`;

afterEach(() => {
  state.files.clear();
  state.pairEnvironment.mockReset();
  vi.restoreAllMocks();
});

describe("consumeBootstrapPairing", () => {
  it("does nothing when no bootstrap pairing file is present", async () => {
    await consumeBootstrapPairing();

    expect(state.pairEnvironment).not.toHaveBeenCalled();
    expect(state.files.has(RESULT_KEY)).toBe(false);
  });

  it("consumes and deletes bootstrap-pair.json on success and writes environmentId", async () => {
    const pairingUrl = "http://100.96.0.18:3773/#token=secret-token";
    const environmentId = EnvironmentId.make("a611dfc7-9bfd-45df-a4f3-e0be974e2691");
    state.files.set(INPUT_KEY, JSON.stringify({ pairingUrl }));
    state.pairEnvironment.mockImplementation(async () => {
      // Input file must already be removed before pairing starts.
      expect(state.files.has(INPUT_KEY)).toBe(false);
      return { ok: true, environmentId, error: null };
    });

    await consumeBootstrapPairing();

    expect(state.pairEnvironment).toHaveBeenCalledWith(pairingUrl);
    expect(state.files.has(INPUT_KEY)).toBe(false);
    const result = JSON.parse(state.files.get(RESULT_KEY) ?? "{}") as {
      ok: boolean;
      environmentId: string | null;
      error: string | null;
      completedAt: string;
    };
    expect(result.ok).toBe(true);
    expect(result.environmentId).toBe(environmentId);
    expect(result.error).toBeNull();
    expect(typeof result.completedAt).toBe("string");
  });

  it("records pairing failures and still deletes bootstrap-pair.json", async () => {
    const pairingUrl = "http://100.96.0.18:3773/#token=bad-token";
    state.files.set(INPUT_KEY, JSON.stringify({ pairingUrl }));
    state.pairEnvironment.mockResolvedValue({
      ok: false,
      error: "Pairing token expired.",
    });

    await consumeBootstrapPairing();

    expect(state.files.has(INPUT_KEY)).toBe(false);
    const result = JSON.parse(state.files.get(RESULT_KEY) ?? "{}") as {
      ok: boolean;
      environmentId: string | null;
      error: string | null;
    };
    expect(result.ok).toBe(false);
    expect(result.environmentId).toBeNull();
    expect(result.error).toBe("Pairing token expired.");
  });
});
