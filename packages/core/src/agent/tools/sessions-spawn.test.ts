import { describe, it, expect, beforeEach } from "vitest";
import { createSessionsSpawnTool } from "./sessions-spawn.js";
import { getSubagentGroup, resetSubagentRegistryForTests } from "../subagent/registry.js";

describe("sessions_spawn tool", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
  });
  it("has correct name and description", () => {
    const tool = createSessionsSpawnTool({ isSubagent: false, sessionId: "test-session" });
    expect(tool.name).toBe("sessions_spawn");
    expect(tool.label).toBe("Spawn Subagent");
    expect(tool.description).toContain("Spawn a background subagent");
  });

  it("rejects spawn from subagent sessions", async () => {
    const tool = createSessionsSpawnTool({ isSubagent: true, sessionId: "child-session" });

    const result = await tool.execute(
      "call-1",
      { task: "do something" } as any,
      new AbortController().signal,
    );

    expect(result.details.status).toBe("error");
    expect(result.details.error).toContain("not allowed from sub-agent sessions");
    const firstContent = result.content[0] as { type: string; text: string };
    expect(firstContent.text).toContain("not allowed");
  });

  it("auto-creates group when custom groupId is provided", async () => {
    const tool = createSessionsSpawnTool({ isSubagent: false, sessionId: "parent-session" });

    // Should not error — the group is auto-created
    await tool.execute(
      "call-group",
      { task: "research topic", label: "Research", groupId: "my-custom-group" } as any,
      new AbortController().signal,
    );

    // Verify group was created in the registry
    const group = getSubagentGroup("my-custom-group");
    expect(group).toBeDefined();
    expect(group!.groupId).toBe("my-custom-group");
    expect(group!.label).toBe("Group: Research");
  });

  it("fails gracefully when Hub is not initialized", async () => {
    const tool = createSessionsSpawnTool({ isSubagent: false, sessionId: "parent-session" });

    const result = await tool.execute(
      "call-2",
      { task: "analyze code", label: "Code Analysis" } as any,
      new AbortController().signal,
    );

    // Should get an error because Hub singleton is not set up in test
    expect(result.details.status).toBe("error");
    expect(result.details.error).toContain("Hub");
  });
});
