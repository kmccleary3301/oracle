import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApprovalGrantAuthority } from "../../browser/approvalToken.js";
import type { ChatgptHistoryDriver } from "../../browser/chatgpt/historyTypes.js";
import {
  branchChatgptHistory,
  editChatgptHistory,
  historyChatgptConversation,
  regenerateChatgptHistory,
  snapshotChatgptHistory,
} from "../../browser/chatgpt/history.js";
import type { ChatgptTemporaryDriver } from "../../browser/chatgpt/temporaryTypes.js";
import {
  closeChatgptTemporaryChat,
  getChatgptTemporaryChatStatus,
  startChatgptTemporaryChat,
} from "../../browser/chatgpt/temporary.js";
import type {
  ChatgptScheduleDriver,
  ChatgptScheduleStore,
} from "../../browser/chatgpt/scheduleTypes.js";
import {
  createChatgptSchedule,
  deleteChatgptSchedule,
  getChatgptSchedule,
  listChatgptSchedules,
  pauseChatgptSchedule,
  reconcileChatgptSchedules,
  resumeChatgptSchedule,
  updateChatgptSchedule,
} from "../../browser/chatgpt/schedules.js";

export interface ChatgptHistorySchedulesDrivers {
  history?: ChatgptHistoryDriver;
  temporary?: ChatgptTemporaryDriver;
  schedules?: ChatgptScheduleDriver;
  scheduleStore?: ChatgptScheduleStore;
  approvalAuthority?: ApprovalGrantAuthority;
  principal?: string;
  session?: string;
}

const approvalChallenge = z.object({
  operation: z.string().min(1),
  target: z.string().min(1),
  revision: z.string().min(1),
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/i),
  expiry: z.number().int().positive(),
});
const approvalGrant = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const identity = {
  conversationId: z.string().min(1),
  turnId: z.string().min(1).optional(),
  messageId: z.string().min(1).optional(),
  blockId: z.string().min(1).optional(),
  expectedRevisionHash: z.string().min(1),
  dryRun: z.boolean().optional(),
  approvalChallenge: approvalChallenge.optional(),
  approvalGrant: approvalGrant.optional(),
};
const output = {
  state: z.enum(["ok", "conflict", "requires_action", "unsupported"]),
  reason: z.string().optional(),
  approvalChallenge: approvalChallenge.optional(),
};
const scheduleIdentity = {
  scheduleId: z.string().min(1),
  expectedRevisionHash: z.string().min(1),
  dryRun: z.boolean().optional(),
  approvalChallenge: approvalChallenge.optional(),
  approvalGrant: approvalGrant.optional(),
};
const recurrence = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), runAt: z.string() }),
  z.object({
    kind: z.literal("daily"),
    hour: z.number().int(),
    minute: z.number().int(),
    timezone: z.string().max(80).optional(),
  }),
  z.object({
    kind: z.literal("weekly"),
    days: z.array(z.number().int()),
    hour: z.number().int(),
    minute: z.number().int(),
    timezone: z.string().max(80).optional(),
  }),
  z.object({
    kind: z.literal("interval"),
    everyMinutes: z.number().int().positive(),
    timezone: z.string().max(80).optional(),
  }),
]);

function unsupported(reason = "browser-driver-not-configured"): {
  state: "unsupported";
  reason: string;
  provenance: [];
} {
  return { state: "unsupported", reason, provenance: [] };
}

function response(value: unknown) {
  const state =
    value && typeof value === "object" && "state" in value
      ? String((value as { state: unknown }).state)
      : "requires_action";
  return {
    structuredContent: value as Record<string, unknown>,
    content: [{ type: "text" as const, text: `ChatGPT operation returned ${state}.` }],
  };
}

export function registerChatgptHistorySchedulesTools(
  server: McpServer,
  drivers: ChatgptHistorySchedulesDrivers = {},
): void {
  const serviceOptions = {
    approvalAuthority: drivers.approvalAuthority,
    principal: drivers.principal,
    session: drivers.session,
  };
  server.registerTool(
    "chatgpt_conversation_snapshot",
    {
      title: "Snapshot ChatGPT conversation",
      description: "Read an ordered conversation snapshot with revision and provenance.",
      inputSchema: { conversationId: z.string().min(1) },
      outputSchema: output,
    },
    async (input) =>
      response(
        drivers.history
          ? await snapshotChatgptHistory(
              drivers.history,
              z.object({ conversationId: z.string().min(1) }).parse(input).conversationId,
            )
          : unsupported(),
      ),
  );
  server.registerTool(
    "chatgpt_conversation_history",
    {
      title: "Read ChatGPT conversation history",
      description: "Read ordered turns for one exact conversation id.",
      inputSchema: { conversationId: z.string().min(1) },
      outputSchema: output,
    },
    async (input) =>
      response(
        drivers.history
          ? await historyChatgptConversation(
              drivers.history,
              z.object({ conversationId: z.string().min(1) }).parse(input).conversationId,
            )
          : unsupported(),
      ),
  );
  server.registerTool(
    "chatgpt_conversation_edit",
    {
      title: "Edit ChatGPT turn",
      description: "Edit one exact user turn after revision and approval-grant checks.",
      inputSchema: { ...identity, text: z.string().min(1).max(100000) },
      outputSchema: output,
    },
    async (input) =>
      response(
        drivers.history
          ? await editChatgptHistory(
              drivers.history,
              z.object({ ...identity, text: z.string().min(1).max(100000) }).parse(input),
              serviceOptions,
            )
          : unsupported(),
      ),
  );
  server.registerTool(
    "chatgpt_conversation_regenerate",
    {
      title: "Regenerate ChatGPT turn",
      description: "Regenerate one exact assistant turn after revision and approval-grant checks.",
      inputSchema: { ...identity, instruction: z.string().max(100000).optional() },
      outputSchema: output,
    },
    async (input) =>
      response(
        drivers.history
          ? await regenerateChatgptHistory(
              drivers.history,
              z
                .object({ ...identity, instruction: z.string().max(100000).optional() })
                .parse(input),
              serviceOptions,
            )
          : unsupported(),
      ),
  );
  server.registerTool(
    "chatgpt_conversation_branch",
    {
      title: "Branch ChatGPT conversation",
      description: "Branch from one exact parent turn and revision.",
      inputSchema: {
        ...identity,
        parentTurnId: z.string().min(1),
        parentMessageId: z.string().min(1).optional(),
      },
      outputSchema: output,
    },
    async (input) =>
      response(
        drivers.history
          ? await branchChatgptHistory(
              drivers.history,
              z
                .object({
                  ...identity,
                  parentTurnId: z.string().min(1),
                  parentMessageId: z.string().min(1).optional(),
                })
                .parse(input),
              serviceOptions,
            )
          : unsupported(),
      ),
  );
  server.registerTool(
    "chatgpt_temporary_chat_start",
    {
      title: "Start temporary ChatGPT chat",
      description: "Start a temporary chat and return only after non-persistence is observed.",
      inputSchema: { conversationId: z.string().min(1).optional() },
      outputSchema: output,
    },
    async (input) =>
      response(
        drivers.temporary
          ? await startChatgptTemporaryChat(
              drivers.temporary,
              z.object({ conversationId: z.string().min(1).optional() }).parse(input),
            )
          : unsupported(),
      ),
  );
  server.registerTool(
    "chatgpt_temporary_chat_status",
    {
      title: "Get temporary ChatGPT chat status",
      description: "Read temporary-chat state and persistence evidence.",
      inputSchema: { conversationId: z.string().min(1).optional() },
      outputSchema: output,
    },
    async (input) =>
      response(
        drivers.temporary
          ? await getChatgptTemporaryChatStatus(
              drivers.temporary,
              z.object({ conversationId: z.string().min(1).optional() }).parse(input),
            )
          : unsupported(),
      ),
  );
  server.registerTool(
    "chatgpt_temporary_chat_close",
    {
      title: "Close temporary ChatGPT chat",
      description: "Close one exact temporary chat and verify non-persistence.",
      inputSchema: { conversationId: z.string().min(1) },
      outputSchema: output,
    },
    async (input) =>
      response(
        drivers.temporary
          ? await closeChatgptTemporaryChat(
              drivers.temporary,
              z.object({ conversationId: z.string().min(1) }).parse(input),
            )
          : unsupported(),
      ),
  );
  server.registerTool(
    "chatgpt_schedule_list",
    {
      title: "List ChatGPT schedules",
      description: "List visible ChatGPT schedules with observed evidence.",
      inputSchema: {},
      outputSchema: output,
    },
    async () =>
      response(drivers.schedules ? await listChatgptSchedules(drivers.schedules) : unsupported()),
  );
  server.registerTool(
    "chatgpt_schedule_get",
    {
      title: "Get ChatGPT schedule",
      description: "Read one exact schedule and revision.",
      inputSchema: { scheduleId: z.string().min(1) },
      outputSchema: output,
    },
    async (input) =>
      response(
        drivers.schedules
          ? await getChatgptSchedule(
              drivers.schedules,
              z.object({ scheduleId: z.string().min(1) }).parse(input).scheduleId,
            )
          : unsupported(),
      ),
  );
  server.registerTool(
    "chatgpt_schedule_create",
    {
      title: "Create ChatGPT schedule",
      description: "Create a schedule with bounded recurrence and approval grant.",
      inputSchema: {
        scheduleId: z.string().min(1).optional(),
        clientRequestId: z.string().min(1).optional(),
        expectedRevisionHash: z.string().min(1).optional(),
        title: z.string().min(1).max(240),
        prompt: z.string().min(1).max(100000),
        recurrence,
        dryRun: z.boolean().optional(),
        approvalChallenge: approvalChallenge.optional(),
        approvalGrant: approvalGrant.optional(),
      },
      outputSchema: output,
    },
    async (input) =>
      response(
        drivers.schedules
          ? await createChatgptSchedule(
              drivers.schedules,
              z
                .object({
                  scheduleId: z.string().min(1).optional(),
                  clientRequestId: z.string().min(1).optional(),
                  expectedRevisionHash: z.string().min(1).optional(),
                  title: z.string().min(1).max(240),
                  prompt: z.string().min(1).max(100000),
                  recurrence,
                  dryRun: z.boolean().optional(),
                  approvalChallenge: approvalChallenge.optional(),
                  approvalGrant: approvalGrant.optional(),
                })
                .parse(input),
              serviceOptions,
            )
          : unsupported(),
      ),
  );
  server.registerTool(
    "chatgpt_schedule_update",
    {
      title: "Update ChatGPT schedule",
      description: "Update one exact schedule revision.",
      inputSchema: {
        ...scheduleIdentity,
        title: z.string().min(1).max(240).optional(),
        prompt: z.string().min(1).max(100000).optional(),
        recurrence: recurrence.optional(),
      },
      outputSchema: output,
    },
    async (input) =>
      response(
        drivers.schedules
          ? await updateChatgptSchedule(
              drivers.schedules,
              z
                .object({
                  ...scheduleIdentity,
                  title: z.string().min(1).max(240).optional(),
                  prompt: z.string().min(1).max(100000).optional(),
                  recurrence: recurrence.optional(),
                })
                .parse(input),
              serviceOptions,
            )
          : unsupported(),
      ),
  );
  server.registerTool(
    "chatgpt_schedule_pause",
    {
      title: "Pause ChatGPT schedule",
      description: "Pause one exact schedule revision.",
      inputSchema: scheduleIdentity,
      outputSchema: output,
    },
    async (input) =>
      response(
        drivers.schedules
          ? await pauseChatgptSchedule(
              drivers.schedules,
              z.object(scheduleIdentity).parse(input),
              serviceOptions,
            )
          : unsupported(),
      ),
  );
  server.registerTool(
    "chatgpt_schedule_resume",
    {
      title: "Resume ChatGPT schedule",
      description: "Resume one exact schedule revision.",
      inputSchema: scheduleIdentity,
      outputSchema: output,
    },
    async (input) =>
      response(
        drivers.schedules
          ? await resumeChatgptSchedule(
              drivers.schedules,
              z.object(scheduleIdentity).parse(input),
              serviceOptions,
            )
          : unsupported(),
      ),
  );
  server.registerTool(
    "chatgpt_schedule_delete",
    {
      title: "Delete ChatGPT schedule",
      description: "Delete one exact schedule revision.",
      inputSchema: scheduleIdentity,
      outputSchema: output,
    },
    async (input) =>
      response(
        drivers.schedules
          ? await deleteChatgptSchedule(
              drivers.schedules,
              z.object(scheduleIdentity).parse(input),
              serviceOptions,
            )
          : unsupported(),
      ),
  );
  server.registerTool(
    "chatgpt_schedule_reconcile",
    {
      title: "Reconcile ChatGPT schedules",
      description:
        "Reconcile local desired schedules against observed ChatGPT state without claiming unobserved recurrence.",
      inputSchema: {},
      outputSchema: output,
    },
    async () =>
      response(
        drivers.schedules && drivers.scheduleStore
          ? await reconcileChatgptSchedules(drivers.schedules, drivers.scheduleStore)
          : unsupported(),
      ),
  );
}
