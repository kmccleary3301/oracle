import { describe, expect, test } from "vitest";
import { ApprovalGrantAuthority } from "../../src/browser/approvalToken.ts";
import { ChatgptProjectLifecycleService } from "../../src/browser/chatgpt/projectLifecycle.ts";
import type {
  ProjectLifecycleDriver,
  ProjectSnapshot,
} from "../../src/browser/chatgpt/projectLifecycleTypes.ts";

function snapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    projectId: "g-p-1",
    revisionHash: "rev-1",
    name: "Alpha",
    url: "https://chatgpt.com/g/g-p-1/project",
    memoryVisibility: "project",
    instructions: "Keep context concise.",
    conversations: [
      {
        conversationId: "c-1",
        url: "https://chatgpt.com/g/g-p-1/c/c-1",
        title: "Parent",
        projectId: "g-p-1",
      },
    ],
    sources: [{ sourceId: "s-1", projectId: "g-p-1", name: "notes.md", status: "ready" }],
    ...overrides,
  };
}

function driver(
  initial: Partial<ProjectSnapshot> = {},
): ProjectLifecycleDriver & { state: ProjectSnapshot; calls: string[] } {
  const value = { state: snapshot(initial), calls: [] as string[] };
  return {
    ...value,
    async listProjects() {
      value.calls.push("list");
      return [value.state];
    },
    async getProject(id) {
      value.calls.push(`get:${id}`);
      if (id !== value.state.projectId) throw new Error("not found");
      return value.state;
    },
    async createProject(input) {
      value.calls.push("create");
      value.state = snapshot({
        projectId: "g-p-2",
        revisionHash: "rev-2",
        name: input.name,
        instructions: input.instructions,
      });
      return value.state;
    },
    async renameProject(input) {
      value.calls.push("rename");
      value.state = snapshot({ name: input.name, revisionHash: "rev-2" });
      return value.state;
    },
    async moveProject(_input) {
      value.calls.push("move");
      value.state = snapshot({ revisionHash: "rev-2" });
      return value.state;
    },
    async deleteProject() {
      value.calls.push("delete");
      value.state = snapshot({ projectId: "deleted", revisionHash: "rev-deleted" });
    },
    async listProjectSources() {
      value.calls.push("sources");
      return value.state.sources;
    },
    async removeProjectSource(input) {
      value.calls.push("remove-source");
      value.state = snapshot({
        revisionHash: "rev-2",
        sources: value.state.sources.filter((source) => source.sourceId !== input.sourceId),
      });
      return value.state;
    },
    async branchProjectConversation(input) {
      value.calls.push("branch");
      const conversation = {
        conversationId: "c-2",
        url: "https://chatgpt.com/g/g-p-1/c/c-2",
        title: "Branch",
        projectId: input.projectId,
        parentConversationId: input.parentConversationId,
      };
      value.state = snapshot({
        revisionHash: "rev-2",
        conversations: [...value.state.conversations, conversation],
      });
      return conversation;
    },
    async previewProjectShare(input) {
      value.calls.push("share-preview");
      return {
        projectId: input.projectId,
        revisionHash: input.expectedRevisionHash,
        target: input.target,
        external: input.target.kind === "user",
        unknown: input.target.kind === "workspace",
        summary: "Share preview",
        capability: {
          pageIdentity: "chatgpt_app",
          loginState: "logged_in",
          projectControls: "available",
          sourceControls: "available",
          shareControls: "available",
          reason: "private DOM omitted",
        },
      };
    },
    async shareProject() {
      value.calls.push("share");
      value.state = snapshot({ revisionHash: "rev-2", memoryVisibility: "shared" });
      return value.state;
    },
  };
}

describe("ChatGPT project lifecycle semantic service", () => {
  test("lists and gets exact project identity with instructions and memory visibility", async () => {
    const d = driver();
    const service = new ChatgptProjectLifecycleService(d);
    await expect(service.listProjects()).resolves.toMatchObject({
      state: "ok",
      projects: [{ projectId: "g-p-1", revisionHash: "rev-1" }],
    });
    await expect(service.getProject("g-p-1")).resolves.toMatchObject({
      state: "ok",
      project: {
        projectId: "g-p-1",
        instructions: "Keep context concise.",
        memoryVisibility: "project",
      },
    });
  });

  test("creates, renames, and reports optimistic revision conflicts before mutation", async () => {
    const d = driver();
    const service = new ChatgptProjectLifecycleService(d);
    await expect(
      service.createProject({ name: "Beta", instructions: "Rules" }),
    ).resolves.toMatchObject({ state: "ok", created: true, project: { projectId: "g-p-2" } });
    const conflict = await service.renameProject({
      projectId: "g-p-2",
      name: "Gamma",
      expectedRevisionHash: "stale",
    });
    expect(conflict).toMatchObject({ state: "conflict", reason: "revision-conflict" });
    expect(d.calls).not.toContain("rename");
  });

  test("source remove dry-run emits an approval challenge and commit consumes its grant", async () => {
    const d = driver();
    const authority = new ApprovalGrantAuthority({ dbPath: ":memory:" });
    const service = new ChatgptProjectLifecycleService(d, { approvalAuthority: authority });
    const preview = await service.removeProjectSource({
      projectId: "g-p-1",
      sourceId: "s-1",
      dryRun: true,
    });
    expect(preview).toMatchObject({
      state: "requires_action",
      approvalChallenge: expect.any(Object),
      sourceId: "s-1",
    });
    if (preview.state !== "requires_action" || !preview.approvalChallenge)
      throw new Error("expected approval challenge");
    const issued = authority.issueGrant(preview.approvalChallenge, { localOperator: true });
    expect(issued.state).toBe("issued");
    if (issued.state !== "issued") return;
    await expect(
      service.removeProjectSource({
        projectId: "g-p-1",
        sourceId: "s-1",
        approvalChallenge: preview.approvalChallenge,
        approvalGrant: issued.grant,
      }),
    ).resolves.toMatchObject({ state: "ok", removed: true, sourceId: "s-1" });
    expect(d.calls).toContain("remove-source");
  });

  test("branches only when returned conversation URL/id and parent identity verify", async () => {
    const d = driver();
    const service = new ChatgptProjectLifecycleService(d);
    await expect(
      service.branchProjectConversation({ projectId: "g-p-1", parentConversationId: "c-1" }),
    ).resolves.toMatchObject({
      state: "ok",
      branched: true,
      conversation: { conversationId: "c-2", parentConversationId: "c-1", projectId: "g-p-1" },
    });
  });

  test("share preview emits a challenge, unknown/external targets require action, known commit verifies revision", async () => {
    const d = driver();
    const authority = new ApprovalGrantAuthority({ dbPath: ":memory:" });
    const service = new ChatgptProjectLifecycleService(d, { approvalAuthority: authority });
    const preview = await service.previewProjectShare({
      projectId: "g-p-1",
      target: { kind: "link" },
    });
    expect(preview).toMatchObject({
      state: "ok",
      approvalChallenge: expect.any(Object),
      preview: { projectId: "g-p-1", revisionHash: "rev-1" },
    });
    if (preview.state !== "ok" || !preview.approvalChallenge)
      throw new Error("expected approval challenge");
    await expect(
      service.shareProject({
        projectId: "g-p-1",
        target: { kind: "user", target: "outside@example.com" },
        approvalChallenge: preview.approvalChallenge,
      }),
    ).resolves.toMatchObject({ state: "requires_action", reason: "external-share-confirmation" });
    const issued = authority.issueGrant(preview.approvalChallenge, { localOperator: true });
    expect(issued.state).toBe("issued");
    if (issued.state !== "issued") return;
    await expect(
      service.shareProject({
        projectId: "g-p-1",
        target: { kind: "link" },
        approvalChallenge: preview.approvalChallenge,
        approvalGrant: issued.grant,
      }),
    ).resolves.toMatchObject({ state: "ok", shared: true, project: { projectId: "g-p-1" } });
  });

  test("delete requires an exact revision and one-time grant; unsupported drivers never click", async () => {
    const d = driver();
    const authority = new ApprovalGrantAuthority({ dbPath: ":memory:" });
    const service = new ChatgptProjectLifecycleService(d, { approvalAuthority: authority });
    const dry = await service.deleteProject({ projectId: "g-p-1", dryRun: true });
    expect(dry).toMatchObject({ state: "requires_action", approvalChallenge: expect.any(Object) });
    if (dry.state !== "requires_action" || !dry.approvalChallenge)
      throw new Error("expected approval challenge");
    await expect(
      service.deleteProject({
        projectId: "g-p-1",
        approvalChallenge: dry.approvalChallenge,
        approvalGrant: "bad",
      }),
    ).resolves.toMatchObject({ state: "requires_action", reason: "approval-grant-unknown" });
    const issued = authority.issueGrant(dry.approvalChallenge, { localOperator: true });
    expect(issued.state).toBe("issued");
    if (issued.state !== "issued") return;
    await expect(
      service.deleteProject({
        projectId: "g-p-1",
        approvalChallenge: dry.approvalChallenge,
        approvalGrant: issued.grant,
      }),
    ).resolves.toMatchObject({ state: "ok", deleted: true });
    const unsupported: ProjectLifecycleDriver = {
      ...driver(),
      async renameProject() {
        throw new Error("unsupported:rename");
      },
    };
    await expect(
      new ChatgptProjectLifecycleService(unsupported).renameProject({
        projectId: "g-p-1",
        name: "New",
      }),
    ).resolves.toMatchObject({ state: "unsupported" });
  });

  test("capability evidence is allow-listed and content is redacted", async () => {
    const d = driver({
      capability: {
        pageIdentity: "chatgpt_app",
        loginState: "logged_in",
        projectControls: "available",
        sourceControls: "available",
        shareControls: "available",
        reason: "secret content that must be bounded",
      },
    });
    const result = await new ChatgptProjectLifecycleService(d).getProject("g-p-1");
    expect(result).toMatchObject({ project: { capability: { pageIdentity: "chatgpt_app" } } });
    expect(JSON.stringify(result)).not.toContain("secret content");
  });
});
