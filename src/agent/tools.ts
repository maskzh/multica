import type { AgentOptions } from "./types.js";
import { getModel, type KnownProvider } from "@mariozechner/pi-ai";
import { createCodingTools } from "@mariozechner/pi-coding-agent";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createExecTool } from "./tools/exec.js";
import { createProcessTool } from "./tools/process.js";
import { createGlobTool } from "./tools/glob.js";

export function resolveModel(options: AgentOptions) {
  if (options.provider && options.model) {
    // Type assertion needed because provider/model come from dynamic user config
    return (getModel as (p: string, m: string) => ReturnType<typeof getModel>)(
      options.provider,
      options.model,
    );
  }
  return getModel("kimi-coding", "kimi-k2-thinking");
}

export function resolveTools(options: AgentOptions): AgentTool<any>[] {
  const cwd = options.cwd ?? process.cwd();
  const baseTools = createCodingTools(cwd).filter((tool) => tool.name !== "bash") as AgentTool<any>[];
  const execTool = createExecTool(cwd);
  const processTool = createProcessTool(cwd);
  const globTool = createGlobTool(cwd);
  return [...baseTools, execTool as AgentTool<any>, processTool as AgentTool<any>, globTool as AgentTool<any>];
}
