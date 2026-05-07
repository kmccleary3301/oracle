import fs from "node:fs/promises";
import type {
  BuildRequestBodyParams,
  FileContent,
  MinimalFsModule,
  OracleRequestBody,
  RunOracleOptions,
  ToolConfig,
} from "./types.js";
import { DEFAULT_SYSTEM_PROMPT } from "./config.js";
import { createFileSections, readFiles } from "./files.js";
import { formatFileSection } from "./markdown.js";
import { createFsAdapter } from "./fsAdapter.js";
import { hasPromptText, normalizePromptText } from "./promptText.js";

export function buildPrompt(basePrompt: string, files: FileContent[], cwd = process.cwd()): string {
  const normalizedPrompt = normalizePromptText(basePrompt);
  if (!files.length) {
    return normalizedPrompt;
  }
  const sections = createFileSections(files, cwd);
  const sectionText = sections.map((section) => section.sectionText).join("\n\n");
  return normalizedPrompt.length > 0 ? `${normalizedPrompt}\n\n${sectionText}` : sectionText;
}

export function buildRequestBody({
  modelConfig,
  systemPrompt,
  userPrompt,
  searchEnabled,
  maxOutputTokens,
  background,
  storeResponse,
  previousResponseId,
}: BuildRequestBodyParams): OracleRequestBody {
  const searchToolType: ToolConfig["type"] = modelConfig.searchToolType ?? "web_search_preview";
  return {
    model: modelConfig.apiModel ?? modelConfig.model,
    previous_response_id: previousResponseId ? previousResponseId : undefined,
    instructions: systemPrompt,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: userPrompt,
          },
        ],
      },
    ],
    tools: searchEnabled ? [{ type: searchToolType }] : undefined,
    reasoning: modelConfig.reasoning || undefined,
    max_output_tokens: maxOutputTokens,
    background: background ? true : undefined,
    store: storeResponse ? true : undefined,
  };
}

export async function renderPromptMarkdown(
  options: Pick<RunOracleOptions, "prompt" | "file" | "system" | "maxFileSizeBytes">,
  deps: { cwd?: string; fs?: MinimalFsModule } = {},
): Promise<string> {
  const cwd = deps.cwd ?? process.cwd();
  const fsModule = deps.fs ?? createFsAdapter(fs);
  const files = await readFiles(options.file ?? [], {
    cwd,
    fsModule,
    maxFileSizeBytes: options.maxFileSizeBytes,
  });
  const sections = createFileSections(files, cwd);
  const systemPrompt = hasPromptText(options.system) ? normalizePromptText(options.system) : DEFAULT_SYSTEM_PROMPT;
  const userPrompt = normalizePromptText(options.prompt ?? "");
  const lines = ["[SYSTEM]", systemPrompt, ""];
  lines.push("[USER]", userPrompt, "");
  sections.forEach((section) => {
    lines.push(formatFileSection(section.displayPath, section.content));
  });
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}
