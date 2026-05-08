import type { ChromeClient, BrowserLogger } from "../types.js";
import {
  INPUT_SELECTORS,
  PROMPT_PRIMARY_SELECTOR,
  PROMPT_FALLBACK_SELECTOR,
  SEND_BUTTON_SELECTORS,
  CONVERSATION_TURN_SELECTOR,
  STOP_BUTTON_SELECTOR,
  ASSISTANT_ROLE_SELECTOR,
} from "../constants.js";
import { delay } from "../utils.js";
import { logDomFailure } from "../domDebug.js";
import { buildClickDispatcher } from "./domEvents.js";
import { BrowserAutomationError } from "../../oracle/errors.js";
import { normalizePromptText } from "../../oracle/promptText.js";

const ENTER_KEY_EVENT = {
  key: "Enter",
  code: "Enter",
  windowsVirtualKeyCode: 13,
  nativeVirtualKeyCode: 13,
} as const;
const ENTER_KEY_TEXT = "\r";

function buildComposerReadValueFunction(): string {
  return `const readValue = (node) => {
        if (!node) return '';
        if (node instanceof HTMLTextAreaElement) return node.value ?? '';
        const normalizeText = (value) => String(value ?? '').replace(/\\u00a0/g, ' ');
        const readNode = (current) => {
          if (!current) return '';
          if (current.nodeType === Node.TEXT_NODE) return normalizeText(current.textContent ?? '');
          if (current.nodeType !== Node.ELEMENT_NODE) return '';
          if (current.nodeName === 'BR') return '\\n';
          return Array.from(current.childNodes ?? []).map(readNode).join('');
        };
        const blockTags = new Set([
          'ADDRESS',
          'ARTICLE',
          'ASIDE',
          'BLOCKQUOTE',
          'DIV',
          'H1',
          'H2',
          'H3',
          'H4',
          'H5',
          'H6',
          'LI',
          'P',
          'PRE',
        ]);
        const children = Array.from(node.childNodes ?? []);
        if (
          children.length > 0 &&
          children.every((child) => child.nodeType === Node.ELEMENT_NODE && blockTags.has(child.nodeName))
        ) {
          return children.map((child) => readNode(child)).join('\\n');
        }
        return normalizeText(node.innerText ?? node.textContent ?? '');
      };`;
}

interface InsertPromptDeps {
  runtime: ChromeClient["Runtime"];
  input: ChromeClient["Input"];
  browser?: ChromeClient["Browser"];
  inputTimeoutMs?: number | null;
}

interface SubmitPreparedPromptDeps extends InsertPromptDeps {
  attachmentNames?: string[];
  baselineTurns?: number | null;
}

export async function submitPrompt(
  deps: SubmitPreparedPromptDeps,
  prompt: string,
  logger: BrowserLogger,
): Promise<number | null> {
  await insertPromptText(deps, prompt, logger);
  return submitPreparedPrompt(deps, prompt, logger);
}

export async function insertPromptText(
  deps: InsertPromptDeps,
  prompt: string,
  logger: BrowserLogger,
): Promise<void> {
  const { runtime, input } = deps;
  const normalizedPrompt = normalizePromptText(prompt);
  const readValueFunction = buildComposerReadValueFunction();

  await waitForDomReady(runtime, logger, deps.inputTimeoutMs ?? undefined);
  const focusResult = await runtime.evaluate({
    expression: `(() => {
      ${buildClickDispatcher()}
      const SELECTORS = ${JSON.stringify(INPUT_SELECTORS)};
      const isVisible = (node) => {
        if (!node || typeof node.getBoundingClientRect !== 'function') {
          return false;
        }
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const focusNode = (node) => {
        if (!node) {
          return false;
        }
        // Learned: React/ProseMirror require a real click + focus + selection for inserts to stick.
        dispatchClickSequence(node);
        if (typeof node.focus === 'function') {
          node.focus();
        }
        if (node instanceof HTMLTextAreaElement && typeof node.setSelectionRange === 'function') {
          node.setSelectionRange(0, node.value.length);
          return true;
        }
        const doc = node.ownerDocument;
        const selection = doc?.getSelection?.();
        if (selection) {
          const range = doc.createRange();
          range.selectNodeContents(node);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        return true;
      };

      const candidates = [];
      for (const selector of SELECTORS) {
        const node = document.querySelector(selector);
        if (node) {
          candidates.push(node);
        }
      }
      const preferred = candidates.find((node) => isVisible(node)) || candidates[0];
      if (preferred && focusNode(preferred)) {
        return { focused: true };
      }
      return { focused: false };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (!focusResult.result?.value?.focused) {
    await logDomFailure(runtime, logger, "focus-textarea");
    throw new Error("Failed to focus prompt textarea");
  }

  await clearFocusedPromptWithKeyboard(input);

  const nativePasteResult = await tryNativeClipboardPaste(deps, normalizedPrompt, readValueFunction);
  if (nativePasteResult.inserted) {
    logger(
      nativePasteResult.asAttachment
        ? "Inserted prompt via ChatGPT pasted-text attachment"
        : "Inserted prompt via native clipboard paste",
    );
  }

  let hardBreakNonExact = false;
  let hardBreakInserted = false;
  if (!nativePasteResult.inserted) {
    const hardBreakResult = await runtime.evaluate({
      expression: `(() => {
        const inputSelectors = ${JSON.stringify(INPUT_SELECTORS)};
        const prompt = ${JSON.stringify(normalizedPrompt)};
        ${readValueFunction}
        const isVisible = (node) => {
          if (!node || typeof node.getBoundingClientRect !== 'function') return false;
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const nodes = inputSelectors
          .map((selector) => document.querySelector(selector))
          .filter((node) => Boolean(node));
        const node = nodes.find((candidate) => isVisible(candidate)) || nodes[0] || null;
        if (!node || node instanceof HTMLTextAreaElement) {
          return { inserted: false, reason: node ? 'textarea' : 'missing-editor', value: '' };
        }
        node.focus?.();
        const selection = document.getSelection?.();
        if (selection) {
          const range = document.createRange();
          range.selectNodeContents(node);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        const lines = prompt.split('\\n');
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          if (line) {
            document.execCommand('insertText', false, line);
          }
          if (index < lines.length - 1) {
            document.execCommand('insertLineBreak');
          }
        }
        node.dispatchEvent(new InputEvent('input', { bubbles: true, data: prompt, inputType: 'insertFromPaste' }));
        const value = readValue(node);
        return { inserted: value === prompt, value };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    const hardBreakValue = String(hardBreakResult.result?.value?.value ?? "");
    hardBreakInserted =
      Boolean(hardBreakResult.result?.value?.inserted) && hardBreakValue === normalizedPrompt;
    hardBreakNonExact = !hardBreakInserted && hardBreakValue.trim().length > 0;
    if (hardBreakInserted) {
      logger("Inserted prompt via contenteditable hard line breaks");
    } else if (hardBreakNonExact) {
      logger("Inserted prompt via contenteditable hard line breaks with non-exact readback");
    } else {
      await input.insertText({ text: normalizedPrompt });
    }
  }

  // Some pages (notably ChatGPT when subscriptions/widgets load) need a brief settle
  // before the send button becomes enabled; give it a short breather to avoid races.
  await delay(500);

  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
  const verification = await runtime.evaluate({
    expression: `(() => {
      const editor = document.querySelector(${primarySelectorLiteral});
      const fallback = document.querySelector(${fallbackSelectorLiteral});
      const inputSelectors = ${JSON.stringify(INPUT_SELECTORS)};
      ${readValueFunction}
      const isVisible = (node) => {
        if (!node || typeof node.getBoundingClientRect !== 'function') return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const candidates = inputSelectors
        .map((selector) => document.querySelector(selector))
        .filter((node) => Boolean(node));
      const active = candidates.find((node) => isVisible(node)) || candidates[0] || null;
      return {
        editorText: editor?.innerText ?? '',
        fallbackValue: fallback?.value ?? '',
        activeValue: active ? readValue(active) : '',
      };
    })()`,
    returnByValue: true,
  });

  const editorTextRaw = verification.result?.value?.editorText ?? "";
  const fallbackValueRaw = verification.result?.value?.fallbackValue ?? "";
  const activeValueRaw = verification.result?.value?.activeValue ?? "";
  const editorTextTrimmed = editorTextRaw?.trim?.() ?? "";
  const fallbackValueTrimmed = fallbackValueRaw?.trim?.() ?? "";
  const activeValueTrimmed = activeValueRaw?.trim?.() ?? "";
  const promptSnippet = normalizedPrompt;
  const containsPromptSnippet = (...values: string[]): boolean => {
    if (!promptSnippet) return true;
    return values.some((value) => normalizePromptText(String(value || "")).includes(promptSnippet));
  };
  const composerEmpty = !editorTextTrimmed && !fallbackValueTrimmed && !activeValueTrimmed;
  const composerContainsPrompt = containsPromptSnippet(
    editorTextRaw,
    fallbackValueRaw,
    activeValueRaw,
  );
  if (composerEmpty && !nativePasteResult.asAttachment) {
    logger("Prompt composer was empty after first insert attempt; retrying after refocus.");
    await runtime.evaluate({
      expression: `(() => {
        ${buildClickDispatcher()}
        const inputSelectors = ${JSON.stringify(INPUT_SELECTORS)};
        const isVisible = (node) => {
          if (!node || typeof node.getBoundingClientRect !== 'function') return false;
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const nodes = inputSelectors
          .map((selector) => document.querySelector(selector))
          .filter((node) => Boolean(node));
        const node = nodes.find((candidate) => isVisible(candidate)) || nodes[0] || null;
        if (!node) return { focused: false };
        dispatchClickSequence(node);
        node.focus?.();
        if (node instanceof HTMLTextAreaElement && typeof node.setSelectionRange === 'function') {
          node.setSelectionRange(0, node.value.length);
          return { focused: true };
        }
        const selection = document.getSelection?.();
        if (selection && !(node instanceof HTMLTextAreaElement)) {
          const range = document.createRange();
          range.selectNodeContents(node);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        return { focused: true };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    await input.insertText({ text: normalizedPrompt });
    await delay(500);
  }
  if (!composerContainsPrompt && !nativePasteResult.asAttachment) {
    logger("Prompt composer readback differed after insertion; preserving non-empty editor state.");
  }

  const promptLength = normalizedPrompt.length;
  const postVerification = await runtime.evaluate({
    expression: `(() => {
      const editor = document.querySelector(${primarySelectorLiteral});
      const fallback = document.querySelector(${fallbackSelectorLiteral});
      const inputSelectors = ${JSON.stringify(INPUT_SELECTORS)};
      ${readValueFunction}
      const isVisible = (node) => {
        if (!node || typeof node.getBoundingClientRect !== 'function') return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const candidates = inputSelectors
        .map((selector) => document.querySelector(selector))
        .filter((node) => Boolean(node));
      const active = candidates.find((node) => isVisible(node)) || candidates[0] || null;
      return {
        editorText: editor?.innerText ?? '',
        fallbackValue: fallback?.value ?? '',
        activeValue: active ? readValue(active) : '',
      };
    })()`,
    returnByValue: true,
  });
  const observedEditor = postVerification.result?.value?.editorText ?? "";
  const observedFallback = postVerification.result?.value?.fallbackValue ?? "";
  const observedActive = postVerification.result?.value?.activeValue ?? "";
  if (
    !containsPromptSnippet(observedEditor, observedFallback, observedActive) &&
    !hardBreakInserted &&
    !hardBreakNonExact &&
    !nativePasteResult.asAttachment
  ) {
    await logDomFailure(runtime, logger, "prompt-insert-mismatch");
    throw new Error("Failed to insert the requested prompt text into the composer.");
  }
  const observedLength = Math.max(
    observedEditor.length,
    observedFallback.length,
    observedActive.length,
  );
  if (
    promptLength >= 50_000 &&
    observedLength > 0 &&
    observedLength < promptLength - 2_000 &&
    !nativePasteResult.asAttachment
  ) {
    // Learned: very large prompts can truncate silently; fail fast so we can fall back to file uploads.
    await logDomFailure(runtime, logger, "prompt-too-large");
    throw new BrowserAutomationError(
      "Prompt appears truncated in the composer (likely too large).",
      {
        stage: "submit-prompt",
        code: "prompt-too-large",
        promptLength,
        observedLength,
      },
    );
  }
}

async function tryNativeClipboardPaste(
  deps: InsertPromptDeps,
  prompt: string,
  readValueFunction: string,
): Promise<{ inserted: boolean; asAttachment: boolean }> {
  const { runtime, input, browser } = deps;
  if (!browser || !shouldUseNativePaste(prompt)) {
    return { inserted: false, asAttachment: false };
  }
  await browser
    .grantPermissions({
      origin: "https://chatgpt.com",
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    })
    .catch(() => undefined);
  const clipboardSet = await runtime.evaluate({
    expression: `(async () => {
      try {
        const previousText = await navigator.clipboard.readText().catch(() => null);
        await navigator.clipboard.writeText(${JSON.stringify(prompt)});
        return { ok: true, previousText };
      } catch {
        return { ok: false, previousText: null };
      }
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  const clipboardState = clipboardSet.result?.value as
    | { ok?: boolean; previousText?: string | null }
    | undefined;
  if (!clipboardState?.ok) {
    return { inserted: false, asAttachment: false };
  }
  await input.dispatchKeyEvent({
    type: "keyDown",
    key: "v",
    code: "KeyV",
    windowsVirtualKeyCode: 86,
    nativeVirtualKeyCode: 86,
    modifiers: 2,
    commands: ["paste"],
  });
  await input.dispatchKeyEvent({
    type: "keyUp",
    key: "v",
    code: "KeyV",
    windowsVirtualKeyCode: 86,
    nativeVirtualKeyCode: 86,
    modifiers: 2,
  });
  await delay(1_000);
  const result = await runtime.evaluate({
    expression: `(() => {
      const inputSelectors = ${JSON.stringify(INPUT_SELECTORS)};
      const prompt = ${JSON.stringify(prompt)};
      ${readValueFunction}
      const isVisible = (node) => {
        if (!node || typeof node.getBoundingClientRect !== 'function') return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const node = inputSelectors
        .map((selector) => document.querySelector(selector))
        .filter(Boolean)
        .find((candidate) => isVisible(candidate)) || null;
      const value = node ? readValue(node) : '';
      const pastedAttachment = Array.from(document.querySelectorAll('button,[aria-label]')).some((candidate) => {
        const aria = candidate.getAttribute?.('aria-label') || '';
        const text = candidate.textContent || '';
        return /pasted text attachment|too long to show in text field/i.test(aria + ' ' + text);
      });
      return { value, pastedAttachment, exact: value === prompt };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  const value = result.result?.value as
    | { exact?: boolean; pastedAttachment?: boolean }
    | undefined;
  await restoreClipboardText(runtime, clipboardState.previousText);
  if (value?.pastedAttachment) {
    return { inserted: true, asAttachment: true };
  }
  return { inserted: Boolean(value?.exact), asAttachment: false };
}

async function restoreClipboardText(
  runtime: ChromeClient["Runtime"],
  previousText: string | null | undefined,
): Promise<void> {
  if (typeof previousText !== "string") return;
  await runtime
    .evaluate({
      expression: `(async () => {
        try {
          await navigator.clipboard.writeText(${JSON.stringify(previousText)});
          return true;
        } catch {
          return false;
        }
      })()`,
      returnByValue: true,
      awaitPromise: true,
    })
    .catch(() => undefined);
}

function shouldUseNativePaste(prompt: string): boolean {
  return prompt.length > 0;
}

async function clearFocusedPromptWithKeyboard(input: ChromeClient["Input"]): Promise<void> {
  await input.dispatchKeyEvent({
    type: "keyDown",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: 2,
    commands: ["selectAll"],
  });
  await input.dispatchKeyEvent({
    type: "keyUp",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: 2,
  });
  await input.dispatchKeyEvent({
    type: "keyDown",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
  });
  await input.dispatchKeyEvent({
    type: "keyUp",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
  });
}

export async function submitPreparedPrompt(
  deps: SubmitPreparedPromptDeps,
  prompt: string,
  logger: BrowserLogger,
): Promise<number | null> {
  const { runtime, input } = deps;
  const clicked = await attemptSendButton(runtime, logger, deps?.attachmentNames);
  if (!clicked) {
    if ((deps.attachmentNames?.length ?? 0) > 0) {
      throw new Error("Send button did not become enabled after attachment upload.");
    }
    await input.dispatchKeyEvent({
      type: "keyDown",
      ...ENTER_KEY_EVENT,
      text: ENTER_KEY_TEXT,
      unmodifiedText: ENTER_KEY_TEXT,
    });
    await input.dispatchKeyEvent({
      type: "keyUp",
      ...ENTER_KEY_EVENT,
    });
    logger("Submitted prompt via Enter key");
  } else {
    logger("Clicked send button");
  }

  const commitTimeoutMs = Math.max(60_000, deps.inputTimeoutMs ?? 0);
  // Learned: the send button can succeed but the turn doesn't appear immediately; verify commit via turns/stop button.
  return await verifyPromptCommitted(
    runtime,
    prompt,
    commitTimeoutMs,
    logger,
    deps.baselineTurns ?? undefined,
  );
}

export async function clearPromptComposer(Runtime: ChromeClient["Runtime"], logger: BrowserLogger) {
  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
  const inputSelectorsLiteral = JSON.stringify(INPUT_SELECTORS);
  const result = await Runtime.evaluate({
    expression: `(() => {
      const fallback = document.querySelector(${fallbackSelectorLiteral});
      const editor = document.querySelector(${primarySelectorLiteral});
      const inputSelectors = ${inputSelectorsLiteral};
      let cleared = false;
      if (fallback) {
        fallback.value = '';
        fallback.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteByCut' }));
        fallback.dispatchEvent(new Event('change', { bubbles: true }));
        cleared = true;
      }
      if (editor) {
        editor.textContent = '';
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteByCut' }));
        cleared = true;
      }
      const nodes = inputSelectors
        .map((selector) => document.querySelector(selector))
        .filter((node) => Boolean(node));
      for (const node of nodes) {
        if (!node) continue;
        if (node instanceof HTMLTextAreaElement) {
          node.value = '';
          node.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteByCut' }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
          cleared = true;
          continue;
        }
        if (node.isContentEditable || node.getAttribute('contenteditable') === 'true') {
          node.textContent = '';
          node.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteByCut' }));
          cleared = true;
        }
      }
      return { cleared };
    })()`,
    returnByValue: true,
  });
  if (!result.result?.value?.cleared) {
    await logDomFailure(Runtime, logger, "clear-composer");
    throw new Error("Failed to clear prompt composer");
  }
  await delay(250);
}

async function waitForDomReady(
  Runtime: ChromeClient["Runtime"],
  logger?: BrowserLogger,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const ready = document.readyState === 'complete';
        const composer = document.querySelector('[data-testid*="composer"]') || document.querySelector('form');
        const fileInput = document.querySelector('input[type="file"]');
        return { ready, composer: Boolean(composer), fileInput: Boolean(fileInput) };
      })()`,
      returnByValue: true,
    });
    const value = result?.value as
      | { ready?: boolean; composer?: boolean; fileInput?: boolean }
      | undefined;
    if (value?.ready && value.composer) {
      return;
    }
    await delay(150);
  }
  logger?.(`Page did not reach ready/composer state within ${timeoutMs}ms; continuing cautiously.`);
}

function buildAttachmentReadyExpression(attachmentNames: string[]): string {
  const namesLiteral = JSON.stringify(attachmentNames.map((name) => name.toLowerCase()));
  return `(() => {
    const names = ${namesLiteral};
    const composer =
      document.querySelector('[data-testid*="composer"]') ||
      document.querySelector('form') ||
      document.body ||
      document;
    const match = (node, name) => (node?.textContent || '').toLowerCase().includes(name);

    // Restrict to attachment affordances; never scan generic div/span nodes (prompt text can contain the file name).
    const attachmentSelectors = [
      '[data-testid*="chip"]',
      '[data-testid*="attachment"]',
      '[data-testid*="upload"]',
      '[aria-label="Remove file"]',
      'button[aria-label="Remove file"]',
    ];

    const chipsReady = names.every((name) =>
      Array.from(composer.querySelectorAll(attachmentSelectors.join(','))).some((node) => match(node, name)),
    );
    const inputsReady = names.every((name) =>
      Array.from(composer.querySelectorAll('input[type="file"]')).some((el) =>
        Array.from((el instanceof HTMLInputElement ? el.files : []) || []).some((file) =>
          file?.name?.toLowerCase?.().includes(name),
        ),
      ),
    );

    return chipsReady || inputsReady;
  })()`;
}

export function buildAttachmentReadyExpressionForTest(attachmentNames: string[]) {
  return buildAttachmentReadyExpression(attachmentNames);
}

async function attemptSendButton(
  Runtime: ChromeClient["Runtime"],
  _logger?: BrowserLogger,
  attachmentNames?: string[],
): Promise<boolean> {
  const script = `(() => {
    ${buildClickDispatcher()}
    const selectors = ${JSON.stringify(SEND_BUTTON_SELECTORS)};
    let button = null;
    for (const selector of selectors) {
      button = document.querySelector(selector);
      if (button) break;
    }
    if (!button) return 'missing';
    const ariaDisabled = button.getAttribute('aria-disabled');
    const dataDisabled = button.getAttribute('data-disabled');
    const style = window.getComputedStyle(button);
    const disabled =
      button.hasAttribute('disabled') ||
      ariaDisabled === 'true' ||
      dataDisabled === 'true' ||
      style.pointerEvents === 'none' ||
      style.display === 'none';
    // Learned: some send buttons render but are inert; only click when truly enabled.
    if (disabled) return 'disabled';
    // Use unified pointer/mouse sequence to satisfy React handlers.
    dispatchClickSequence(button);
    return 'clicked';
  })()`;

  const deadline = Date.now() + ((attachmentNames?.length ?? 0) > 0 ? 30_000 : 8_000);
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({ expression: script, returnByValue: true });
    if (result.value === "clicked") {
      return true;
    }
    if (result.value === "missing") {
      break;
    }
    await delay(100);
  }
  return false;
}

async function verifyPromptCommitted(
  Runtime: ChromeClient["Runtime"],
  prompt: string,
  timeoutMs: number,
  logger?: BrowserLogger,
  baselineTurns?: number,
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  const normalizedPrompt = normalizePromptText(prompt);
  const encodedPrompt = JSON.stringify(normalizedPrompt);
  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
  const inputSelectorsLiteral = JSON.stringify(INPUT_SELECTORS);
  const stopSelectorLiteral = JSON.stringify(STOP_BUTTON_SELECTOR);
  const assistantSelectorLiteral = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  const turnSelectorLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  let baseline: number | null =
    typeof baselineTurns === "number" && Number.isFinite(baselineTurns) && baselineTurns >= 0
      ? Math.floor(baselineTurns)
      : null;
  if (baseline === null) {
    try {
      const { result } = await Runtime.evaluate({
        expression: `document.querySelectorAll(${turnSelectorLiteral}).length`,
        returnByValue: true,
      });
      const raw = typeof result?.value === "number" ? result.value : Number(result?.value);
      if (Number.isFinite(raw)) {
        baseline = Math.max(0, Math.floor(raw));
      }
    } catch {
      // ignore; baseline stays unknown
    }
  }
  const baselineLiteral = baseline ?? -1;
  // Learned: ChatGPT can echo/format text; normalize markdown and use prefix matches to detect the sent prompt.
  const script = `(() => {
		    const editor = document.querySelector(${primarySelectorLiteral});
		    const fallback = document.querySelector(${fallbackSelectorLiteral});
		    const inputSelectors = ${inputSelectorsLiteral};
	    const normalize = (value) => {
	      let text = value?.toLowerCase?.() ?? '';
	      // Strip markdown *markers* but keep content (ChatGPT renders fence markers differently).
	      text = text.replace(/\`\`\`[^\\n]*\\n([\\s\\S]*?)\`\`\`/g, ' $1 ');
	      text = text.replace(/\`\`\`/g, ' ');
	      text = text.replace(/\`([^\`]*)\`/g, '$1');
	      return text.replace(/\\s+/g, ' ').trim();
	    };
	    const normalizedPrompt = normalize(${encodedPrompt});
	    const normalizedPromptPrefix = normalizedPrompt.slice(0, 120);
	    const CONVERSATION_SELECTOR = ${JSON.stringify(CONVERSATION_TURN_SELECTOR)};
	    const articles = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
	    const normalizedTurns = articles.map((node) => normalize(node?.innerText));
	    const readValue = (node) => {
	      if (!node) return '';
	      if (node instanceof HTMLTextAreaElement) return node.value ?? '';
	      return node.innerText ?? '';
	    };
	    const isVisible = (node) => {
	      if (!node || typeof node.getBoundingClientRect !== 'function') return false;
	      const rect = node.getBoundingClientRect();
	      return rect.width > 0 && rect.height > 0;
	    };
	    const inputs = inputSelectors
	      .map((selector) => document.querySelector(selector))
	      .filter((node) => Boolean(node));
	    const visibleInputs = inputs.filter((node) => isVisible(node));
	    const activeInputs = visibleInputs.length > 0 ? visibleInputs : inputs;
	    const userMatched =
	      normalizedPrompt.length > 0 && normalizedTurns.some((text) => text.includes(normalizedPrompt));
	    const prefixMatched =
	      normalizedPromptPrefix.length > 30 &&
	      normalizedTurns.some((text) => text.includes(normalizedPromptPrefix));
		    const lastTurn = normalizedTurns[normalizedTurns.length - 1] ?? '';
		    const lastMatched =
		      normalizedPrompt.length > 0 &&
		      (lastTurn.includes(normalizedPrompt) ||
		        (normalizedPromptPrefix.length > 30 && lastTurn.includes(normalizedPromptPrefix)));
		    const baseline = ${baselineLiteral};
		    const hasNewTurn = baseline < 0 ? false : normalizedTurns.length > baseline;
		    const stopVisible = Boolean(document.querySelector(${stopSelectorLiteral}));
		    const assistantVisible = Boolean(
		      document.querySelector(${assistantSelectorLiteral}) ||
		      document.querySelector('[data-testid*="assistant"]'),
		    );
	    // Learned: composer clearing + stop button or assistant presence is a reliable fallback signal.
      const editorValue = editor?.innerText ?? '';
      const fallbackValue = fallback?.value ?? '';
      const activeEmpty =
        activeInputs.length === 0 ? null : activeInputs.every((node) => !String(readValue(node)).trim());
      const composerCleared = activeEmpty ?? !(String(editorValue).trim() || String(fallbackValue).trim());
      const href = typeof location === 'object' && location.href ? location.href : '';
      const inConversation = /\\/c\\//.test(href);
      const hasPastedTextAttachment = Array.from(document.querySelectorAll('button,[aria-label]')).some((node) => {
        const aria = node.getAttribute?.('aria-label') || '';
        const text = node.textContent || '';
        return /pasted text attachment|too long to show in text field/i.test(aria + ' ' + text);
      });
		    return {
        baseline,
	      userMatched,
	      prefixMatched,
	      lastMatched,
	      hasNewTurn,
	      stopVisible,
      assistantVisible,
      composerCleared,
      inConversation,
      hasPastedTextAttachment,
      href,
      fallbackValue,
      editorValue,
      lastTurn,
      turnsCount: normalizedTurns.length,
    };
  })()`;

  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({ expression: script, returnByValue: true });
    const info = result.value as {
      baseline?: number;
      userMatched?: boolean;
      prefixMatched?: boolean;
      lastMatched?: boolean;
      hasNewTurn?: boolean;
      stopVisible?: boolean;
      assistantVisible?: boolean;
      composerCleared?: boolean;
      inConversation?: boolean;
      hasPastedTextAttachment?: boolean;
      turnsCount?: number;
    };
    const turnsCount = (result.value as { turnsCount?: number } | undefined)?.turnsCount;
    const matchesPrompt = Boolean(info?.lastMatched || info?.userMatched || info?.prefixMatched);
    const baselineUnknown =
      typeof info?.baseline === "number" ? info.baseline < 0 : baselineLiteral < 0;
    if (matchesPrompt && (baselineUnknown || info?.hasNewTurn)) {
      return typeof turnsCount === "number" && Number.isFinite(turnsCount) ? turnsCount : null;
    }
    const fallbackCommit =
      info?.composerCleared &&
      Boolean(info?.hasNewTurn) &&
      ((info?.stopVisible ?? false) || info?.assistantVisible || info?.inConversation);
    if (fallbackCommit) {
      return typeof turnsCount === "number" && Number.isFinite(turnsCount) ? turnsCount : null;
    }
    const durableSubmission =
      info?.composerCleared &&
      Boolean(info?.inConversation) &&
      (Boolean(info?.hasNewTurn) ||
        Boolean(info?.stopVisible) ||
        Boolean(info?.assistantVisible) ||
        Boolean(info?.hasPastedTextAttachment));
    if (durableSubmission) {
      return typeof turnsCount === "number" && Number.isFinite(turnsCount) ? turnsCount : null;
    }
    await delay(100);
  }
  if (logger) {
    logger(
      `Prompt commit check failed; latest state: ${await Runtime.evaluate({
        expression: script,
        returnByValue: true,
      })
        .then((res) => JSON.stringify(res?.result?.value))
        .catch(() => "unavailable")}`,
    );
    await logDomFailure(Runtime, logger, "prompt-commit");
  }
  if (normalizedPrompt.length >= 50_000) {
    throw new BrowserAutomationError(
      "Prompt did not appear in conversation before timeout (likely too large).",
      {
        stage: "submit-prompt",
        code: "prompt-too-large",
        promptLength: normalizedPrompt.length,
        timeoutMs,
      },
    );
  }
  throw new Error("Prompt did not appear in conversation before timeout (send may have failed)");
}

// biome-ignore lint/style/useNamingConvention: test-only export used in vitest suite
export const __test__ = {
  buildComposerReadValueFunction,
  verifyPromptCommitted,
};
