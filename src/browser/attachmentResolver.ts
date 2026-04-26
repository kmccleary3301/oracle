import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFiles } from "../oracle/files.js";
import { FileValidationError } from "../oracle/errors.js";
import type { BrowserAttachment } from "./types.js";

const DEFAULT_MAX_CHATGPT_ATTACHMENTS = 20;
const DEFAULT_MAX_CHATGPT_IMAGE_ATTACHMENTS = 20;
const DEFAULT_MAX_CHATGPT_ATTACHMENT_BYTES = 512 * 1024 * 1024;
const ZIP_VERSION_NEEDED = 20;
const ZIP_STORE_METHOD = 0;
const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".jpg",
  ".jpeg",
  ".png",
  ".svg",
  ".webp",
]);

interface ZipEntry {
  entryName: string;
  crc32: number;
  size: number;
  offset: number;
}

export interface ResolveBrowserAttachmentsOptions {
  cwd?: string;
  maxAttachments?: number;
  maxImageAttachments?: number;
  maxTotalBytes?: number;
  bundleName?: string;
}

export async function resolveBrowserAttachments(
  inputs: string[],
  options: ResolveBrowserAttachmentsOptions = {},
): Promise<BrowserAttachment[]> {
  if (!inputs || inputs.length === 0) {
    return [];
  }
  const cwd = options.cwd ?? process.cwd();
  const maxAttachments = options.maxAttachments ?? DEFAULT_MAX_CHATGPT_ATTACHMENTS;
  const maxImageAttachments = options.maxImageAttachments ?? DEFAULT_MAX_CHATGPT_IMAGE_ATTACHMENTS;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_CHATGPT_ATTACHMENT_BYTES;
  const resolvedFiles = await readFiles(inputs, {
    cwd,
    readContents: false,
    maxFileSizeBytes: 0,
  });
  const attachments: BrowserAttachment[] = [];
  for (const file of resolvedFiles) {
    const stat = await fs.stat(file.path);
    attachments.push({
      path: file.path,
      displayPath: path.relative(cwd, file.path) || path.basename(file.path),
      sizeBytes: stat.size,
    });
  }
  const totalBytes = attachments.reduce((sum, attachment) => sum + (attachment.sizeBytes ?? 0), 0);
  if (maxTotalBytes > 0 && totalBytes > maxTotalBytes) {
    throw new FileValidationError(
      `ChatGPT browser attachments exceed the ${formatBytes(maxTotalBytes)} aggregate limit (${formatBytes(totalBytes)} selected).`,
      { limitBytes: maxTotalBytes, totalBytes, files: attachments.map((item) => item.displayPath) },
    );
  }

  if (maxAttachments > 0 && attachments.length > maxAttachments) {
    const imageAttachments = attachments.filter((attachment) =>
      isImageAttachmentPath(attachment.path),
    );
    const otherAttachments = attachments.filter(
      (attachment) => !isImageAttachmentPath(attachment.path),
    );
    if (
      otherAttachments.length === 0 &&
      (maxImageAttachments <= 0 || imageAttachments.length <= maxImageAttachments)
    ) {
      return attachments;
    }
    if (maxImageAttachments > 0 && imageAttachments.length > maxImageAttachments) {
      throw new FileValidationError(
        `ChatGPT browser image attachments exceed the configured ${maxImageAttachments} image limit (${imageAttachments.length} selected).`,
        {
          limit: maxImageAttachments,
          count: imageAttachments.length,
          files: imageAttachments.map((item) => item.displayPath),
        },
      );
    }
    const bundleSource = otherAttachments.length > 0 ? otherAttachments : attachments;
    const bundlePath = await createZipBundle(bundleSource, {
      cwd,
      bundleName: options.bundleName ?? "attachments-bundle.zip",
    });
    const stat = await fs.stat(bundlePath);
    const planned = [
      ...imageAttachments,
      {
        path: bundlePath,
        displayPath: bundlePath,
        sizeBytes: stat.size,
      },
    ];
    const plannedTotalBytes = planned.reduce(
      (sum, attachment) => sum + (attachment.sizeBytes ?? 0),
      0,
    );
    if (maxTotalBytes > 0 && plannedTotalBytes > maxTotalBytes) {
      throw new FileValidationError(
        `ChatGPT browser attachment plan exceeds the ${formatBytes(maxTotalBytes)} aggregate limit after bundling (${formatBytes(plannedTotalBytes)} planned).`,
        {
          limitBytes: maxTotalBytes,
          totalBytes: plannedTotalBytes,
          files: planned.map((item) => item.displayPath),
        },
      );
    }
    if (planned.length > maxAttachments) {
      throw new FileValidationError(
        `ChatGPT browser attachment plan still exceeds the configured ${maxAttachments} upload limit after bundling (${planned.length} planned uploads).`,
        { maxAttachments, count: planned.length, files: planned.map((item) => item.displayPath) },
      );
    }
    return planned;
  }
  return attachments;
}

function isImageAttachmentPath(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

async function createZipBundle(
  attachments: BrowserAttachment[],
  options: { cwd: string; bundleName: string },
): Promise<string> {
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-attachments-"));
  const bundlePath = path.join(bundleDir, options.bundleName);
  const handle = await fs.open(bundlePath, "w");
  const entries: ZipEntry[] = [];
  let offset = 0;
  const usedNames = new Set<string>();
  const timestamp = zipTimestamp(new Date());

  try {
    for (const attachment of attachments) {
      const data = await fs.readFile(attachment.path);
      const entryName = makeUniqueZipEntryName(
        normalizeZipEntryName(
          attachment.displayPath || path.relative(options.cwd, attachment.path),
        ),
        usedNames,
      );
      usedNames.add(entryName);
      const crc32 = computeCrc32(data);
      const nameBytes = Buffer.from(entryName, "utf8");
      const localHeader = Buffer.alloc(30 + nameBytes.length);
      localHeader.writeUInt32LE(0x04034b50, 0);
      localHeader.writeUInt16LE(ZIP_VERSION_NEEDED, 4);
      localHeader.writeUInt16LE(0x0800, 6);
      localHeader.writeUInt16LE(ZIP_STORE_METHOD, 8);
      localHeader.writeUInt16LE(timestamp.time, 10);
      localHeader.writeUInt16LE(timestamp.date, 12);
      localHeader.writeUInt32LE(crc32, 14);
      localHeader.writeUInt32LE(data.length, 18);
      localHeader.writeUInt32LE(data.length, 22);
      localHeader.writeUInt16LE(nameBytes.length, 26);
      localHeader.writeUInt16LE(0, 28);
      nameBytes.copy(localHeader, 30);
      await handle.write(localHeader);
      await handle.write(data);
      entries.push({
        entryName,
        crc32,
        size: data.length,
        offset,
      });
      offset += localHeader.length + data.length;
    }

    const centralStart = offset;
    for (const entry of entries) {
      const nameBytes = Buffer.from(entry.entryName, "utf8");
      const centralHeader = Buffer.alloc(46 + nameBytes.length);
      centralHeader.writeUInt32LE(0x02014b50, 0);
      centralHeader.writeUInt16LE(ZIP_VERSION_NEEDED, 4);
      centralHeader.writeUInt16LE(ZIP_VERSION_NEEDED, 6);
      centralHeader.writeUInt16LE(0x0800, 8);
      centralHeader.writeUInt16LE(ZIP_STORE_METHOD, 10);
      centralHeader.writeUInt16LE(timestamp.time, 12);
      centralHeader.writeUInt16LE(timestamp.date, 14);
      centralHeader.writeUInt32LE(entry.crc32, 16);
      centralHeader.writeUInt32LE(entry.size, 20);
      centralHeader.writeUInt32LE(entry.size, 24);
      centralHeader.writeUInt16LE(nameBytes.length, 28);
      centralHeader.writeUInt16LE(0, 30);
      centralHeader.writeUInt16LE(0, 32);
      centralHeader.writeUInt16LE(0, 34);
      centralHeader.writeUInt16LE(0, 36);
      centralHeader.writeUInt32LE(0, 38);
      centralHeader.writeUInt32LE(entry.offset, 42);
      nameBytes.copy(centralHeader, 46);
      await handle.write(centralHeader);
      offset += centralHeader.length;
    }

    const centralSize = offset - centralStart;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralStart, 16);
    end.writeUInt16LE(0, 20);
    await handle.write(end);
  } finally {
    await handle.close();
  }

  return bundlePath;
}

function normalizeZipEntryName(value: string): string {
  const normalized = value
    .split(path.sep)
    .join("/")
    .replace(/^[A-Za-z]:\//, "")
    .replace(/^\/+/, "")
    .replace(/(^|\/)\.\.(?=\/|$)/g, "")
    .replace(/\/{2,}/g, "/")
    .trim();
  return normalized || "attachment";
}

function makeUniqueZipEntryName(name: string, used: Set<string>): string {
  if (!used.has(name)) return name;
  const ext = path.posix.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 2; ; i += 1) {
    const candidate = `${stem}-${i}${ext}`;
    if (!used.has(candidate)) return candidate;
  }
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function computeCrc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipTimestamp(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);
  return {
    time: (hours << 11) | (minutes << 5) | seconds,
    date: ((year - 1980) << 9) | (month << 5) | day,
  };
}
