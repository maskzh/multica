import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import fg from "fast-glob";
import * as path from "path";
import * as fs from "fs/promises";

const GlobSchema = Type.Object({
  pattern: Type.String({
    description: "Glob pattern to match files (e.g., '**/*.ts', 'src/**/*.{js,jsx}').",
  }),
  cwd: Type.Optional(
    Type.String({
      description: "Directory to search in. Defaults to current working directory.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum number of results to return. Defaults to 100.",
      minimum: 1,
      maximum: 1000,
    }),
  ),
  ignore: Type.Optional(
    Type.Array(Type.String(), {
      description: "Patterns to exclude from results (e.g., ['node_modules/**', '*.test.ts']).",
    }),
  ),
});

type GlobArgs = {
  pattern: string;
  cwd?: string;
  limit?: number;
  ignore?: string[];
};

export type GlobResult = {
  files: string[];
  count: number;
  truncated: boolean;
};

const DEFAULT_LIMIT = 100;
const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/coverage/**",
];

export function createGlobTool(defaultCwd?: string): AgentTool<typeof GlobSchema, GlobResult> {
  return {
    name: "glob",
    label: "Glob",
    description:
      "Find files matching a glob pattern. Returns file paths sorted by modification time (most recent first). " +
      "Use this to discover files in the codebase before reading them. " +
      "Examples: '**/*.ts' for all TypeScript files, 'src/**/*.{js,jsx}' for JS files in src.",
    parameters: GlobSchema,
    execute: async (_toolCallId, args, _signal) => {
      const { pattern, cwd, limit, ignore } = args as GlobArgs;

      if (!pattern || pattern.trim() === "") {
        throw new Error("Pattern must not be empty");
      }

      const searchDir = cwd || defaultCwd || process.cwd();
      const maxResults = Math.min(limit || DEFAULT_LIMIT, 1000);
      const ignorePatterns = ignore || DEFAULT_IGNORE;

      // Verify the search directory exists
      try {
        const stat = await fs.stat(searchDir);
        if (!stat.isDirectory()) {
          throw new Error(`Path is not a directory: ${searchDir}`);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`Directory not found: ${searchDir}`);
        }
        throw err;
      }

      // Run glob search
      const files = await fg(pattern, {
        cwd: searchDir,
        ignore: ignorePatterns,
        onlyFiles: true,
        followSymbolicLinks: true,
        dot: true, // Include dotfiles
        absolute: false, // Return relative paths
        suppressErrors: true, // Don't throw on permission errors
      });

      // Get file stats for sorting by modification time
      const filesWithStats = await Promise.all(
        files.map(async (file) => {
          const fullPath = path.join(searchDir, file);
          try {
            const stat = await fs.stat(fullPath);
            return { file, mtime: stat.mtimeMs };
          } catch {
            // If we can't stat the file, use 0 as mtime
            return { file, mtime: 0 };
          }
        }),
      );

      // Sort by modification time (most recent first)
      filesWithStats.sort((a, b) => b.mtime - a.mtime);

      // Apply limit
      const truncated = filesWithStats.length > maxResults;
      const limitedFiles = filesWithStats.slice(0, maxResults).map((f) => f.file);

      const resultText =
        limitedFiles.length > 0
          ? limitedFiles.join("\n") + (truncated ? `\n... (${filesWithStats.length - maxResults} more files)` : "")
          : "No files found matching the pattern.";

      return {
        content: [{ type: "text", text: resultText }],
        details: {
          files: limitedFiles,
          count: limitedFiles.length,
          truncated,
        },
      };
    },
  };
}
