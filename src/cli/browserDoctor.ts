import { constants as fsConstants } from "node:fs";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import chalk from "chalk";
import { detectChromeBinary } from "../browser/detect.js";
import { resolveBrowserConfig } from "../browser/config.js";
import type { BrowserAutomationConfig } from "../browser/types.js";

const execFileAsync = promisify(execFile);

export interface BrowserDoctorOptions {
  config?: BrowserAutomationConfig;
  json?: boolean;
}

export interface BrowserDoctorReport {
  platform: NodeJS.Platform;
  arch: string;
  osRelease: string;
  isWsl: boolean;
  chromePath: string | null;
  chromeKind: "windows" | "linux" | "macos" | "unknown";
  remoteChrome: { host: string; port: number } | null;
  manualLogin: boolean;
  configuredProfileDir: string | null;
  profileDir: string | null;
  profileWritable: boolean | null;
  profileError: string | null;
  requiresWindowsLocalProfile: boolean;
  requiresWslDevtoolsBridge: boolean;
  warnings: string[];
  problems: string[];
}

export async function runBrowserDoctor(options: BrowserDoctorOptions = {}): Promise<void> {
  const report = await createBrowserDoctorReport(options.config);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatBrowserDoctorReport(report));
  }
  process.exitCode = report.problems.length ? 1 : 0;
}

export async function createBrowserDoctorReport(
  configInput?: BrowserAutomationConfig,
): Promise<BrowserDoctorReport> {
  const detectedChrome = await detectChromeBinary();
  const config = resolveBrowserConfig({
    ...(configInput ?? {}),
    chromePath: configInput?.chromePath ?? detectedChrome.path,
  });
  const chromePath = config.chromePath ?? detectedChrome.path;
  const chromeKind = classifyChromePath(chromePath);
  const isWslRuntime = isWsl();
  const configuredProfileDir = config.remoteChrome ? null : (config.manualLoginProfileDir ?? null);
  const profileDir =
    configuredProfileDir && isWslRuntime && chromeKind === "windows"
      ? await resolveWindowsLocalProfileDir(configuredProfileDir)
      : configuredProfileDir;
  const profileCheck = profileDir ? await checkProfileWritable(profileDir) : null;
  const warnings: string[] = [];
  const problems: string[] = [];

  if (!chromePath && !config.remoteChrome) {
    problems.push("No Chrome binary detected. Install Chrome/Chromium or configure chromePath.");
  }
  if (process.platform === "linux" && !isWslRuntime && chromeKind === "windows") {
    problems.push("A Windows Chrome binary is configured on a non-WSL Linux runtime.");
  }
  if (
    isWslRuntime &&
    chromeKind === "windows" &&
    configuredProfileDir &&
    !isWindowsMountedPath(configuredProfileDir)
  ) {
    warnings.push(
      "WSL is using Windows Chrome; Oracle maps the configured Linux profile path to a Windows-local profile before launch.",
    );
  }
  if (profileCheck && !profileCheck.writable) {
    problems.push(`Profile directory is not writable: ${profileDir} (${profileCheck.error})`);
  }
  if (!config.remoteChrome && !profileDir) {
    warnings.push("No manual-login profile directory is configured.");
  }
  if (process.platform === "linux" && !isWslRuntime && profileDir?.startsWith("/mnt/")) {
    warnings.push("True Linux should normally use a Linux-local profile path, not /mnt/...");
  }

  return {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    isWsl: isWslRuntime,
    chromePath,
    chromeKind,
    remoteChrome: config.remoteChrome ?? null,
    manualLogin: Boolean(config.manualLogin),
    configuredProfileDir,
    profileDir,
    profileWritable: profileCheck?.writable ?? null,
    profileError: profileCheck?.error ?? null,
    requiresWindowsLocalProfile: isWslRuntime && chromeKind === "windows",
    requiresWslDevtoolsBridge:
      isWslRuntime && chromeKind === "windows" && Boolean(config.remoteChrome?.host),
    warnings,
    problems,
  };
}

function formatBrowserDoctorReport(report: BrowserDoctorReport): string {
  const lines: string[] = [];
  lines.push(chalk.bold("Browser doctor"));
  lines.push(chalk.dim(`OS: ${report.platform} ${report.osRelease} (${report.arch})`));
  lines.push(chalk.dim(`WSL: ${report.isWsl ? "yes" : "no"}`));
  lines.push("");
  lines.push(chalk.bold("Chrome"));
  lines.push(
    `Binary: ${report.chromePath ? chalk.green(report.chromePath) : chalk.red("not found")}`,
  );
  lines.push(`Kind: ${formatState(report.chromeKind, report.chromeKind !== "unknown")}`);
  lines.push("");
  lines.push(chalk.bold("Session"));
  if (report.remoteChrome) {
    lines.push(
      `Remote Chrome: ${chalk.green(`${report.remoteChrome.host}:${report.remoteChrome.port}`)}`,
    );
  } else {
    lines.push("Remote Chrome: not configured");
  }
  lines.push(
    `Manual login: ${formatState(report.manualLogin ? "enabled" : "disabled", report.manualLogin)}`,
  );
  if (report.configuredProfileDir && report.configuredProfileDir !== report.profileDir) {
    lines.push(`Configured profile dir: ${report.configuredProfileDir}`);
  }
  lines.push(`Profile dir: ${report.profileDir ?? "(none)"}`);
  if (report.profileWritable === null) {
    lines.push("Profile writable: n/a");
  } else {
    lines.push(
      `Profile writable: ${report.profileWritable ? chalk.green("yes") : chalk.red("no")}`,
    );
  }
  lines.push("");
  lines.push(chalk.bold("Environment Requirements"));
  lines.push(
    `Windows-local profile required: ${formatState(report.requiresWindowsLocalProfile ? "yes" : "no", !report.requiresWindowsLocalProfile)}`,
  );
  lines.push(
    `WSL DevTools bridge required: ${formatState(report.requiresWslDevtoolsBridge ? "yes" : "no", !report.requiresWslDevtoolsBridge)}`,
  );

  if (report.warnings.length) {
    lines.push("");
    lines.push(chalk.yellowBright("Warnings:"));
    for (const warning of report.warnings) {
      lines.push(chalk.yellow(`- ${warning}`));
    }
  }
  if (report.problems.length) {
    lines.push("");
    lines.push(chalk.redBright("Problems:"));
    for (const problem of report.problems) {
      lines.push(chalk.red(`- ${problem}`));
    }
  }
  return lines.join("\n");
}

async function checkProfileWritable(
  profileDir: string,
): Promise<{ writable: boolean; error: string | null }> {
  try {
    await fs.mkdir(profileDir, { recursive: true });
    await fs.access(profileDir, fsConstants.W_OK);
    return { writable: true, error: null };
  } catch (error) {
    return {
      writable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function resolveWindowsLocalProfileDir(configuredProfileDir: string): Promise<string> {
  if (isWindowsMountedPath(configuredProfileDir)) {
    return configuredProfileDir;
  }
  const localAppData = await readWindowsLocalAppDataPath();
  const localAppDataWsl = isWindowsMountedPath(localAppData)
    ? localAppData
    : await convertWindowsPathToWsl(localAppData);
  const resolved = path.resolve(configuredProfileDir);
  const slug = sanitizeProfileLabel(path.basename(resolved) || "browser-profile");
  const hash = crypto.createHash("sha1").update(resolved).digest("hex").slice(0, 10);
  return path.join(localAppDataWsl, "Oracle", "browser-profiles", `${slug}-${hash}`);
}

async function readWindowsLocalAppDataPath(): Promise<string> {
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (localAppData) {
    return localAppData;
  }
  const { stdout } = await execFileAsync(
    "cmd.exe",
    ["/d", "/s", "/c", "cd /d %SystemDrive%\\ >nul 2>&1 && echo %LOCALAPPDATA%"],
    { encoding: "utf8" },
  );
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines[index] ?? "";
    if (/^[A-Za-z]:\\/.test(candidate)) {
      return candidate;
    }
  }
  throw new Error("Unable to resolve %LOCALAPPDATA% for Windows Chrome profile diagnostics.");
}

async function convertWindowsPathToWsl(windowsPath: string): Promise<string> {
  if (isWindowsMountedPath(windowsPath)) {
    return windowsPath;
  }
  const { stdout } = await execFileAsync("wslpath", ["-u", windowsPath], { encoding: "utf8" });
  const resolved = stdout.trim();
  if (!resolved) {
    throw new Error(`Unable to map Windows path to WSL path: ${windowsPath}`);
  }
  return resolved;
}

function sanitizeProfileLabel(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "browser-profile";
}

function formatState(value: string, ok: boolean): string {
  return ok ? chalk.green(value) : chalk.yellow(value);
}

function classifyChromePath(
  candidate: string | null | undefined,
): BrowserDoctorReport["chromeKind"] {
  const value = (candidate ?? "").trim();
  if (!value) return "unknown";
  if ((/[a-z]:\\/i.test(value) || /^\/mnt\/[a-z]\//i.test(value)) && /\.exe$/i.test(value)) {
    return "windows";
  }
  if (value.includes(".app/Contents/MacOS/")) {
    return "macos";
  }
  if (value.startsWith("/")) {
    return "linux";
  }
  return "unknown";
}

function isWindowsMountedPath(candidate: string): boolean {
  return /^\/mnt\/[a-z]\//i.test(path.resolve(candidate));
}

function isWsl(): boolean {
  return (
    process.platform === "linux" &&
    Boolean(process.env.WSL_DISTRO_NAME || os.release().toLowerCase().includes("microsoft"))
  );
}
