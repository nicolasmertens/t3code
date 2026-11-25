import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isInternalAgentServer } from "./ThreadServersPanel";

describe("isInternalAgentServer", () => {
  it("hides internal agent helper servers when started outside a terminal", () => {
    expect(isInternalAgentServer({ terminal: null, processName: "agy" })).toBe(true);
    expect(isInternalAgentServer({ terminal: null, processName: "antigravity" })).toBe(true);
    expect(isInternalAgentServer({ terminal: null, processName: "t3" })).toBe(true);
    expect(isInternalAgentServer({ terminal: null, processName: "acp-mcp-bridge" })).toBe(true);
  });

  it("keeps real dev servers and terminal-owned processes", () => {
    expect(isInternalAgentServer({ terminal: null, processName: "vite" })).toBe(false);
    expect(isInternalAgentServer({ terminal: null, processName: "node" })).toBe(false);
    expect(
      isInternalAgentServer({
        terminal: { threadId: ThreadId.make("t-1"), terminalId: "term-1" },
        processName: "t3",
      }),
    ).toBe(false);
    expect(isInternalAgentServer({ terminal: null, processName: null })).toBe(false);
  });
});
