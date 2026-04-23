import { afterEach, describe, expect, test } from "vitest";
import { __test__ } from "../../src/browser/chatgpt/projects.ts";

type AnchorStub = {
  href: string;
  innerText?: string;
  textContent?: string;
  getAttribute(name: string): string | null;
};

const originalDocument = globalThis.document;
const originalLocation = globalThis.location;

function anchor(href: string, text: string): AnchorStub {
  return {
    href,
    innerText: text,
    textContent: text,
    getAttribute(name: string) {
      if (name === "href") return href;
      if (name === "aria-label" || name === "title") return text;
      return null;
    },
  };
}

describe("ChatGPT project extraction", () => {
  afterEach(() => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument,
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  test("includes project-main conversation links, not only sidebar links", () => {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: {
        href: "https://chatgpt.com/g/g-p-abc123-image-gen/project",
      },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        querySelectorAll(selector: string) {
          expect(selector).toBe("a");
          return [
            anchor("https://chatgpt.com/c/sidebar-conversation", "Sidebar conversation"),
            anchor(
              "https://chatgpt.com/g/g-p-abc123-image-gen/c/project-conversation",
              "Project image request",
            ),
          ];
        },
      },
    });

    const conversations = Function(`return ${__test__.buildConversationListExpression()}`)() as Array<{
      conversationId: string;
      projectId?: string;
      title: string;
      url: string;
    }>;

    expect(conversations).toEqual([
      expect.objectContaining({
        conversationId: "sidebar-conversation",
        projectId: "g-p-abc123-image-gen",
        title: "Sidebar conversation",
      }),
      expect.objectContaining({
        conversationId: "project-conversation",
        projectId: "g-p-abc123-image-gen",
        title: "Project image request",
        url: "https://chatgpt.com/g/g-p-abc123-image-gen/c/project-conversation",
      }),
    ]);
  });
});
