import { afterEach, describe, expect, test } from "vitest";
import { __test__ } from "../../src/browser/chatgpt/projects.ts";

type AnchorStub = {
  href: string;
  innerText?: string;
  textContent?: string;
  getAttribute(name: string): string | null;
};

type ElementStub = {
  textContent?: string;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { width: number; height: number };
};

const originalDocument = globalThis.document;
const originalLocation = globalThis.location;
const originalHTMLElement = globalThis.HTMLElement;

class TestHTMLElement {
  textContent?: string;
  private readonly attributes: Record<string, string | null>;

  constructor(text: string, attributes: Record<string, string | null>) {
    this.textContent = text;
    this.attributes = attributes;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  getBoundingClientRect(): { width: number; height: number } {
    return { width: 100, height: 20 };
  }
}

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

function visibleElement(text: string, attributes: Record<string, string | null> = {}): ElementStub {
  return new TestHTMLElement(text, attributes);
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
    Object.defineProperty(globalThis, "HTMLElement", {
      configurable: true,
      value: originalHTMLElement,
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

    const conversations = Function(
      `return ${__test__.buildConversationListExpression()}`,
    )() as Array<{
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

  test("uses the visible project title button before slug-derived fallbacks", () => {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: {
        href: "https://chatgpt.com/g/g-p-abc123-oracle-ubuntu-qa-temp/project",
      },
    });
    Object.defineProperty(globalThis, "HTMLElement", {
      configurable: true,
      value: TestHTMLElement,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        querySelectorAll(selector: string) {
          if (selector === "a") return [];
          if (selector === 'button[name="project-title"]') {
            return [
              visibleElement("Oracle Ubuntu QA Temp", {
                name: "project-title",
              }),
            ];
          }
          if (selector === "h1,h2,[role='heading']") {
            return [visibleElement("Chat history")];
          }
          return [];
        },
      },
    });

    const project = Function(
      `return ${__test__.buildCurrentProjectExpression("https://chatgpt.com/g/g-p-abc123-oracle-ubuntu-qa-temp/project")}`,
    )() as {
      name: string;
      projectId?: string;
    };

    expect(project.name).toBe("Oracle Ubuntu QA Temp");
    expect(project.projectId).toBe("g-p-abc123-oracle-ubuntu-qa-temp");
  });
});
