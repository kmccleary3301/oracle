import { constants as fsConstants, createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  downloadChatgptFile,
  fingerprintChatgptFile,
  inferChatgptFileMimeType,
  preflightChatgptFile,
} from "../../browser/chatgpt/files.js";
import type { ChatgptFileDownloadPolicy } from "../../browser/chatgpt/types.js";

const quotaShape = z.object({
  lane: z.string().min(1),
  observedAt: z.string().min(1),
  source: z.enum(["browser", "response", "header", "caller"]),
  used: z.number().nonnegative().optional(),
  limit: z.number().nonnegative().optional(),
  remaining: z.number().nonnegative().optional(),
  resetAt: z.string().optional(),
});

const rateLimitShape = z.object({
  lane: z.string().min(1),
  observedAt: z.string().min(1),
  source: z.enum(["browser", "response", "header", "caller"]),
  retryAfterMs: z.number().nonnegative().optional(),
});

const fingerprintShape = z.object({
  absolutePath: z.string(),
  displayName: z.string(),
  sizeBytes: z.number(),
  modifiedAtMs: z.number(),
  device: z.number().optional(),
  inode: z.number().optional(),
  sha256: z.string(),
});

const preflightInputShape = {
  filePath: z.string().min(1),
  lane: z.string().optional(),
  mimeType: z.string().optional(),
  supportedMimeTypes: z.array(z.string()).optional(),
  supportedExtensions: z.array(z.string()).optional(),
  maxBytes: z.number().nonnegative().optional(),
  quota: quotaShape.optional(),
  rateLimit: rateLimitShape.optional(),
  requiresAction: z.string().optional(),
} satisfies z.ZodRawShape;

const preflightOutputShape = {
  operation: z.literal("file.preflight"),
  status: z.enum([
    "accepted",
    "unsupported",
    "too_large",
    "quota_exhausted",
    "rate_limited",
    "requires_action",
  ]),
  fingerprint: fingerprintShape,
  evidence: z.object({
    observedAt: z.string(),
    lane: z.string(),
    sizeBytes: z.number(),
    mimeType: z.string().optional(),
    extension: z.string().optional(),
    maxBytes: z.number().optional(),
    quota: quotaShape.optional(),
    rateLimit: rateLimitShape.optional(),
    reason: z.string().optional(),
    action: z.string().optional(),
  }),
  retryAfterMs: z.number().optional(),
} satisfies z.ZodRawShape;

const getInputShape = {
  filePath: z.string().min(1),
  fileId: z.string().min(1).optional(),
} satisfies z.ZodRawShape;

const getOutputShape = {
  operation: z.literal("file.get"),
  fileId: z.string(),
  name: z.string(),
  sizeBytes: z.number(),
  sha256: z.string(),
  path: z.string(),
} satisfies z.ZodRawShape;

const downloadInputShape = {
  sourcePath: z.string().min(1),
  destinationPath: z.string().min(1),
  fileId: z.string().min(1).optional(),
} satisfies z.ZodRawShape;

const downloadOutputShape = {
  operation: z.literal("file.download"),
  fileId: z.string(),
  name: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  sha256: z.string(),
  downloadedPath: z.string(),
  provenance: z.object({
    source: z.literal("chatgpt-file"),
    fileId: z.string(),
    name: z.string(),
    conversationId: z.string().optional(),
    turnId: z.string().optional(),
    messageId: z.string().optional(),
  }),
} satisfies z.ZodRawShape;

const preflightInputSchema = z.object(preflightInputShape).strict();
const getInputSchema = z.object(getInputShape).strict();
const downloadInputSchema = z.object(downloadInputShape).strict();

function textContent(text: string): CallToolResult["content"] {
  return [{ type: "text", text }];
}

function safeFailure(): CallToolResult {
  return {
    isError: true,
    content: textContent("ChatGPT file operation failed without exposing sensitive local details."),
  };
}

export interface ChatgptFilesToolDependencies {
  readonly policy?: ChatgptFileDownloadPolicy;
}

export function registerChatgptFilesTools(
  server: McpServer,
  dependencies: ChatgptFilesToolDependencies = {},
): void {
  server.registerTool(
    "chatgpt_file_preflight",
    {
      title: "Preflight a ChatGPT file",
      description:
        "Fingerprint a local file and report only evidence-backed MIME, extension, size, quota, and rate-limit status. Unknown quotas remain unknown.",
      inputSchema: preflightInputShape,
      outputSchema: preflightOutputShape,
    },
    async (input: unknown): Promise<CallToolResult> => {
      try {
        const parsed = preflightInputSchema.parse(input);
        const result = await preflightChatgptFile(parsed.filePath, parsed);
        return { structuredContent: { ...result }, content: textContent(JSON.stringify(result)) };
      } catch {
        return safeFailure();
      }
    },
  );

  server.registerTool(
    "chatgpt_file_get",
    {
      title: "Get ChatGPT file metadata",
      description:
        "Return an immutable local file record suitable for matching a ChatGPT upload. The file id defaults to its SHA-256 and never uses base64.",
      inputSchema: getInputShape,
      outputSchema: getOutputShape,
    },
    async (input: unknown): Promise<CallToolResult> => {
      try {
        const parsed = getInputSchema.parse(input);
        const fingerprint = await fingerprintChatgptFile(parsed.filePath);
        const result = {
          operation: "file.get" as const,
          fileId: parsed.fileId ?? fingerprint.sha256,
          name: fingerprint.displayName,
          sizeBytes: fingerprint.sizeBytes,
          sha256: fingerprint.sha256,
          path: fingerprint.absolutePath,
        };
        return { structuredContent: result, content: textContent(JSON.stringify(result)) };
      } catch {
        return safeFailure();
      }
    },
  );

  server.registerTool(
    "chatgpt_file_download",
    {
      title: "Download a ChatGPT file",
      description:
        "Stream a file from an existing local/remote adapter path to a destination and verify its immutable size and hash without base64 encoding.",
      inputSchema: downloadInputShape,
      outputSchema: downloadOutputShape,
    },
    async (input: unknown): Promise<CallToolResult> => {
      try {
        const parsed = downloadInputSchema.parse(input);
        const policy = dependencies.policy;
        if (!policy) return safeFailure();
        const fingerprint = await fingerprintChatgptFile(parsed.sourcePath, {
          maxBytes: policy.maxDownloadBytes,
        });
        const fileId = parsed.fileId ?? fingerprint.sha256;
        const result = await downloadChatgptFile({
          fileId,
          destinationPath: parsed.destinationPath,
          policy,
          get: async () => ({
            fileId,
            name: fingerprint.displayName,
            sizeBytes: fingerprint.sizeBytes,
            sha256: fingerprint.sha256,
            mimeType: inferChatgptFileMimeType(fingerprint.displayName),
          }),
          download: async () => {
            const sourceHandle = await open(
              fingerprint.absolutePath,
              fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
            );
            try {
              const sourceStats = await sourceHandle.stat();
              if (
                !sourceStats.isFile() ||
                sourceStats.size !== fingerprint.sizeBytes ||
                Number(sourceStats.dev) !== fingerprint.device ||
                Number(sourceStats.ino) !== fingerprint.inode
              ) {
                throw new Error("The source file changed before it was downloaded.");
              }
              return createReadStream(fingerprint.absolutePath, {
                fd: sourceHandle.fd,
                autoClose: true,
              });
            } catch (error) {
              await sourceHandle.close().catch(() => undefined);
              throw error;
            }
          },
        });
        return { structuredContent: { ...result }, content: textContent(JSON.stringify(result)) };
      } catch {
        return safeFailure();
      }
    },
  );
}

export const __test__ = {
  preflightInputSchema,
  getInputSchema,
  downloadInputSchema,
};
