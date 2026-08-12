import { describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  imageMode: "mismatch" as "mismatch" | "verified",
  createSession: vi.fn(),
  generateImage: vi.fn(),
  verifyImageMode: vi.fn(),
  extractImages: vi.fn(),
  workService: { start: vi.fn() },
  connect: vi.fn(),
  closeTarget: vi.fn(),
}));

vi.mock("../../src/browser/chatgpt/imageService.js", () => ({
  generateChatgptImage: mocks.generateImage,
  editChatgptImage: mocks.generateImage,
  verifyChatgptImageModeFromConfiguredBrowser: mocks.verifyImageMode,
}));
vi.mock("../../src/browser/chatgpt/session.js", () => ({
  createChatgptSession: mocks.createSession,
  sendChatgptTurn: vi.fn(),
}));
vi.mock("../../src/browser/chatgpt/work.js", () => ({
  createRuntimeWorkService: vi.fn(() => mocks.workService),
}));
vi.mock("../../src/config.js", () => ({
  loadUserConfig: vi.fn(async () => ({
    config: { browser: { remoteChrome: { host: "127.0.0.1", port: 9222 } } },
  })),
}));
vi.mock("../../src/browser/attachmentResolver.js", () => ({
  resolveBrowserAttachments: vi.fn(async (files: string[]) =>
    files.map((path) => ({ path, displayPath: path })),
  ),
}));
vi.mock("../../src/browser/chatgpt/imageArtifacts.js", () => ({
  extractChatgptImagesFromConfiguredBrowser: mocks.extractImages,
}));
vi.mock("../../src/browser/chatgpt/sandboxArtifacts.js", () => ({
  extractChatgptSandboxArtifactsFromConfiguredBrowser: vi.fn(),
}));
vi.mock("../../src/browser/chromeLifecycle.js", () => ({
  connectToRemoteChrome: mocks.connect,
  closeRemoteChromeTarget: mocks.closeTarget,
}));
vi.mock("../../src/browser/actions/navigation.js", () => ({ navigateToChatGPT: vi.fn() }));

const { createChatgptDaemonHandlers, runChatgptWorkOperation } =
  await import("../../src/daemon/chatgptHandlers.js");

function context() {
  return {
    jobId: "job-test",
    signal: new AbortController().signal,
    setPhase: vi.fn(async () => undefined),
    updateRuntime: vi.fn(async () => undefined),
    markSubmission: vi.fn(async () => undefined),
    log: vi.fn(async () => undefined),
  };
}

const image = {
  fileId: "file-1",
  sourceUrl: "https://chatgpt.com/backend-api/files/file-1",
  turnId: "turn-1",
  messageId: "message-1",
  turnIndex: 1,
  variantIndex: 0,
  outputIndex: 0,
  renderedWidth: 1024,
  renderedHeight: 1024,
  isThumbnail: false,
  duplicateNodeCount: 1,
};

function imageTurn() {
  return {
    status: "completed",
    submitted: true,
    conversationUrl: "https://chatgpt.com/c/conversation-1",
    answerText: "done",
    answerMarkdown: "done",
    tookMs: 10,
    generatedImages: [image],
    newGeneratedImages: [image],
    warnings: [],
  };
}

describe("durable ChatGPT daemon route parity", () => {
  test("image mode mismatch verifies before createSession and verified mode returns an artifact", async () => {
    const handler = createChatgptDaemonHandlers().find(
      (entry) => entry.kind === "chatgpt_generate_images",
    )!;
    mocks.createSession.mockReset();
    mocks.verifyImageMode.mockImplementation(async () => ({
      supported: mocks.imageMode === "verified",
      verified: mocks.imageMode === "verified",
      selectedMode: mocks.imageMode === "verified" ? "images" : "chat",
      availableModes: ["chat", "images"],
      pageIdentity: "chatgpt_app",
      loginLikely: true,
      source: "dom",
      reason: "mode mismatch",
    }));
    mocks.generateImage.mockImplementation(
      async (options: {
        verifyMode: () => Promise<unknown>;
        createSession: (input: unknown) => Promise<unknown>;
      }) => {
        const evidence = await options.verifyMode();
        if (!(evidence as { verified: boolean }).verified) {
          return {
            operation: "generate",
            state: "unsupported",
            warnings: ["mode mismatch"],
            failure: { code: "mode_unverified", message: "mode mismatch", retryable: false },
          };
        }
        const turn = await options.createSession({ prompt: "generate", attachments: [] });
        return {
          operation: "generate",
          state: "completed",
          warnings: [],
          outputs: [image],
          value: { turn },
        };
      },
    );
    const mismatch = context();
    mocks.imageMode = "mismatch";
    await expect(handler.run(mismatch, { prompt: "generate" })).rejects.toThrow(/mode mismatch/);
    expect(mocks.createSession).not.toHaveBeenCalled();

    mocks.imageMode = "verified";
    mocks.createSession.mockResolvedValue(imageTurn());
    mocks.extractImages.mockResolvedValue({
      page: { href: "https://chatgpt.com/c/conversation-1", generatedImageNodeCount: 1 },
      images: [],
      artifacts: [],
      warnings: [],
    });
    const verified = context();
    const result = await handler.run(verified, { prompt: "generate" });
    expect(result).toMatchObject({ uniqueGeneratedImageCount: 1, images: [image] });
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
  });

  test("Work start returns observed identity and persists it in runtime", async () => {
    mocks.connect.mockResolvedValue({
      targetId: "target-1",
      client: {
        Page: { enable: vi.fn() },
        Runtime: { enable: vi.fn() },
        Input: {},
        close: vi.fn(),
      },
    });
    const observed = {
      state: "running",
      accepted: true,
      conversationId: "new-conversation",
      conversationUrl: "https://chatgpt.com/c/new-conversation",
      taskId: "task-1",
      turnId: "turn-1",
      revisionHash: "rev-1",
      deliverables: [{ id: "artifact-1" }],
      provenance: [{ source: "chatgpt-dom", capturedAt: "2026-01-01T00:00:00.000Z" }],
    };
    mocks.workService.start.mockResolvedValue(observed);
    const runContext = context();
    const result = await runChatgptWorkOperation("start", { prompt: "work" }, runContext);
    expect(result).toMatchObject(observed);
    expect(runContext.updateRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "new-conversation",
        conversationUrl: observed.conversationUrl,
        work: expect.objectContaining({
          state: observed.state,
          conversationId: observed.conversationId,
          taskId: observed.taskId,
          turnId: observed.turnId,
          revisionHash: observed.revisionHash,
          deliverables: observed.deliverables,
          provenance: observed.provenance,
        }),
      }),
    );
  });
});
