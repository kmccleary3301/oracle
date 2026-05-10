import path from "node:path";
import { readFiles } from "../oracle/files.js";

export interface NormalizedDurableJobFile {
  originalPath: string;
  resolvedPath: string;
}

export async function normalizeDurableJobFileInputs(
  inputs: string[],
  submitCwd: string,
): Promise<NormalizedDurableJobFile[]> {
  if (inputs.length === 0) {
    return [];
  }
  const files = await readFiles(inputs, {
    cwd: submitCwd,
    readContents: false,
    maxFileSizeBytes: 0,
  });
  const originalByResolved = new Map<string, string>();
  for (const input of inputs) {
    const trimmed = input.trim();
    if (!trimmed || trimmed.startsWith("!")) continue;
    if (!trimmed.includes("*") && !trimmed.includes("?") && !trimmed.includes("[")) {
      originalByResolved.set(path.resolve(submitCwd, trimmed), trimmed);
    }
  }
  return files.map((file) => ({
    originalPath: originalByResolved.get(file.path) ?? file.path,
    resolvedPath: file.path,
  }));
}
