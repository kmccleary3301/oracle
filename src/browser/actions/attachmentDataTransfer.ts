import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ChromeClient, BrowserAttachment } from "../types.js";

const MAX_DATA_TRANSFER_BYTES = 20 * 1024 * 1024;

export async function transferAttachmentViaDataTransfer(
  runtime: ChromeClient["Runtime"],
  attachment: BrowserAttachment,
  selector: string,
): Promise<{ fileName: string; size: number }> {
  const fileContent = await readFile(attachment.path);
  if (fileContent.length > MAX_DATA_TRANSFER_BYTES) {
    throw new Error(
      `Attachment ${path.basename(attachment.path)} is too large for data transfer (${fileContent.length} bytes). Maximum size is ${MAX_DATA_TRANSFER_BYTES} bytes.`,
    );
  }

  const base64Content = fileContent.toString("base64");
  const fileName = path.basename(attachment.path);
  const mimeType = guessMimeType(fileName);

  const expression = `(() => {
    if (!('File' in window) || !('Blob' in window) || !('DataTransfer' in window) || typeof atob !== 'function') {
      return { success: false, error: 'Required file APIs are not available in this browser' };
    }

    const fileInput = document.querySelector(${JSON.stringify(selector)});
    if (!fileInput) {
      return { success: false, error: 'File input not found' };
    }
    if (!(fileInput instanceof HTMLInputElement) || fileInput.type !== 'file') {
      return { success: false, error: 'Found element is not a file input' };
    }

    const base64Data = ${JSON.stringify(base64Content)};
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: ${JSON.stringify(mimeType)} });

    const file = new File([blob], ${JSON.stringify(fileName)}, {
      type: ${JSON.stringify(mimeType)},
      lastModified: Date.now(),
    });

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    let assigned = false;

    const proto = Object.getPrototypeOf(fileInput);
    const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'files') : null;
    if (descriptor?.set) {
      try {
        descriptor.set.call(fileInput, dataTransfer.files);
        assigned = true;
      } catch {
        assigned = false;
      }
    }
    if (!assigned) {
      try {
        Object.defineProperty(fileInput, 'files', {
          configurable: true,
          get: () => dataTransfer.files,
        });
        assigned = true;
      } catch {
        assigned = false;
      }
    }
    if (!assigned) {
      try {
        fileInput.files = dataTransfer.files;
        assigned = true;
      } catch {
        assigned = false;
      }
    }
    if (!assigned) {
      return { success: false, error: 'Unable to assign FileList to input' };
    }

    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true, fileName: file.name, size: file.size };
  })()`;

  const evalResult = await runtime.evaluate({ expression, returnByValue: true });
  if (evalResult.exceptionDetails) {
    const description = evalResult.exceptionDetails.text ?? "JS evaluation failed";
    throw new Error(`Failed to transfer file to browser: ${description}`);
  }

  if (
    !evalResult.result ||
    typeof evalResult.result.value !== "object" ||
    evalResult.result.value == null
  ) {
    throw new Error("Failed to transfer file to browser: unexpected evaluation result");
  }

  const uploadResult = evalResult.result.value as {
    success?: boolean;
    error?: string;
    fileName?: string;
    size?: number;
  };
  if (!uploadResult.success) {
    throw new Error(`Failed to transfer file to browser: ${uploadResult.error || "Unknown error"}`);
  }

  return {
    fileName: uploadResult.fileName ?? fileName,
    size: typeof uploadResult.size === "number" ? uploadResult.size : fileContent.length,
  };
}

export async function transferAttachmentViaCdpDrag(
  deps: { runtime: ChromeClient["Runtime"]; input?: ChromeClient["Input"] },
  attachment: BrowserAttachment,
  hostPathCandidates: string[],
): Promise<{ fileName: string; size: number; path: string }> {
  const { runtime, input } = deps;
  if (!input || typeof input.dispatchDragEvent !== "function") {
    throw new Error("Chrome Input domain unavailable for CDP drag/drop upload.");
  }
  const fileName = path.basename(attachment.path);
  const fileContent = await readFile(attachment.path);
  const { result } = await runtime.evaluate({
    expression: `(() => {
      const prompt = document.querySelector('#prompt-textarea,[contenteditable="true"],textarea');
      const target =
        prompt?.closest('form') ||
        prompt?.closest('[data-testid*="composer"]') ||
        prompt?.parentElement ||
        document.querySelector('main') ||
        document.body;
      if (!(target instanceof Element)) return null;
      const rect = target.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    })()`,
    returnByValue: true,
  });
  const point = result?.value as { x?: number; y?: number } | null | undefined;
  if (typeof point?.x !== "number" || typeof point?.y !== "number") {
    throw new Error("Unable to locate a CDP drag/drop target.");
  }
  let lastError: unknown;
  for (const candidate of hostPathCandidates) {
    try {
      const data = {
        items: [{ mimeType: guessMimeType(fileName), data: "" }],
        files: [candidate],
        dragOperationsMask: 1,
      };
      await input.dispatchDragEvent({ type: "dragEnter", x: point.x, y: point.y, data });
      await new Promise((resolve) => setTimeout(resolve, 650));
      await input.dispatchDragEvent({ type: "dragOver", x: point.x, y: point.y, data });
      await new Promise((resolve) => setTimeout(resolve, 650));
      await input.dispatchDragEvent({ type: "drop", x: point.x, y: point.y, data });
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      return { fileName, size: fileContent.length, path: candidate };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `CDP drag/drop upload failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

export async function transferAttachmentViaDrop(
  runtime: ChromeClient["Runtime"],
  attachment: BrowserAttachment,
): Promise<{ fileName: string; size: number; duplicate?: boolean }> {
  const fileContent = await readFile(attachment.path);
  if (fileContent.length > MAX_DATA_TRANSFER_BYTES) {
    throw new Error(
      `Attachment ${path.basename(attachment.path)} is too large for drag transfer (${fileContent.length} bytes). Maximum size is ${MAX_DATA_TRANSFER_BYTES} bytes.`,
    );
  }

  const fileName = path.basename(attachment.path);
  const mimeType = guessMimeType(fileName);
  const expression = `async () => {
    if (!('File' in window) || !('Blob' in window) || !('DataTransfer' in window) || typeof atob !== 'function') {
      return { success: false, error: 'Required drag/drop file APIs are not available in this browser' };
    }

    const base64Data = ${JSON.stringify(fileContent.toString("base64"))};
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i += 1) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const file = new File(
      [new Blob([bytes], { type: ${JSON.stringify(mimeType)} })],
      ${JSON.stringify(fileName)},
      { type: ${JSON.stringify(mimeType)}, lastModified: Date.now() },
    );
    const makeTransfer = () => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      dataTransfer.effectAllowed = 'copy';
      dataTransfer.dropEffect = 'copy';
      return dataTransfer;
    };
    const promptSelectors = [
      '#prompt-textarea',
      '[contenteditable="true"]',
      'textarea',
    ];
    let prompt = null;
    for (const selector of promptSelectors) {
      prompt = document.querySelector(selector);
      if (prompt) break;
    }
    const roots = [
      prompt?.closest('form'),
      prompt?.closest('[data-testid*="composer"]'),
      prompt?.parentElement,
      document.querySelector('main'),
      document.body,
      document.documentElement,
    ].filter(Boolean);
    if (roots.length === 0) {
      return { success: false, error: 'Unable to locate a drop target' };
    }
    const dispatch = (target, type) => {
      const dataTransfer = makeTransfer();
      let event;
      try {
        event = new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          dataTransfer,
        });
      } catch {
        event = new Event(type, { bubbles: true, cancelable: true, composed: true });
        Object.defineProperty(event, 'dataTransfer', {
          configurable: true,
          value: dataTransfer,
        });
      }
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    for (const target of roots) {
      dispatch(target, 'dragenter');
      dispatch(target, 'dragover');
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
    for (const target of roots) {
      dispatch(target, 'drop');
    }
    await new Promise((resolve) => setTimeout(resolve, 8000));
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const expected = normalize(file.name);
    const duplicate = Array.from(document.querySelectorAll('[data-testid*="duplicate"],[role="dialog"],[data-testid*="modal"]')).some((node) =>
      /already uploaded|duplicate/i.test(node.textContent || ''),
    );
    const foundChip = Array.from(document.querySelectorAll('[data-testid*="attachment"],[data-testid*="upload"],[data-testid*="file"],[data-testid*="chip"],[aria-label*="Remove"],[aria-label*="remove"],button')).some((node) => {
      const values = [
        node.textContent || '',
        node.getAttribute?.('aria-label') || '',
        node.getAttribute?.('title') || '',
        node.getAttribute?.('data-testid') || '',
      ];
      return values.some((value) => normalize(value).includes(expected));
    });
    const foundInput = Array.from(document.querySelectorAll('input[type="file"]')).some((input) =>
      Array.from(input.files || []).some((item) => normalize(item?.name).includes(expected)),
    );
    if (!foundChip && !foundInput && !duplicate) {
      return { success: false, error: 'Drop did not produce an attachment signal' };
    }
    return { success: true, fileName: file.name, size: file.size, duplicate };
  }`;

  const evalResult = await runtime.evaluate({
    expression: `(${expression})()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (evalResult.exceptionDetails) {
    const description = evalResult.exceptionDetails.text ?? "JS evaluation failed";
    throw new Error(`Failed to drop file in browser: ${description}`);
  }
  const uploadResult = evalResult.result?.value as
    | { success?: boolean; error?: string; fileName?: string; size?: number; duplicate?: boolean }
    | undefined;
  if (!uploadResult?.success) {
    throw new Error(`Failed to drop file in browser: ${uploadResult?.error || "Unknown error"}`);
  }
  return {
    fileName: uploadResult.fileName ?? fileName,
    size: typeof uploadResult.size === "number" ? uploadResult.size : fileContent.length,
    duplicate: Boolean(uploadResult.duplicate),
  };
}

export function guessMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",

    ".json": "application/json",
    ".js": "text/javascript",
    ".ts": "text/typescript",
    ".jsx": "text/javascript",
    ".tsx": "text/typescript",
    ".py": "text/x-python",
    ".java": "text/x-java",
    ".c": "text/x-c",
    ".cpp": "text/x-c++",
    ".h": "text/x-c",
    ".hpp": "text/x-c++",
    ".sh": "text/x-sh",
    ".bash": "text/x-sh",

    ".html": "text/html",
    ".css": "text/css",
    ".xml": "text/xml",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",

    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",

    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",

    ".zip": "application/zip",
    ".tar": "application/x-tar",
    ".gz": "application/gzip",
    ".7z": "application/x-7z-compressed",
  };

  return mimeTypes[ext] || "application/octet-stream";
}
