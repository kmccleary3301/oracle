import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CURRENT_VERSION = "2.0.0-current";
const PREVIOUS_VERSION = "1.0.0-previous";
const NPM_COMMAND = process.platform === "win32" ? process.execPath : "npm";
const NPM_ARGUMENT_PREFIX =
  process.platform === "win32"
    ? [resolve(process.execPath, "..", "node_modules", "npm", "bin", "npm-cli.js")]
    : [];

function run(command, args, options = {}) {
  try {
    return {
      status: 0,
      stdout: execFileSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        ...options,
      }),
    };
  } catch (error) {
    return {
      status: typeof error?.status === "number" ? error.status : 1,
      stdout: String(error?.stdout ?? ""),
      stderr: String(error?.stderr ?? ""),
    };
  }
}
function runNpm(args, options = {}) {
  return run(NPM_COMMAND, [...NPM_ARGUMENT_PREFIX, ...args], options);
}

function writeFixture(root, version, mode) {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "oracle-rollback-fixture",
        version,
        description: "Deterministic packaged rollback fixture",
        private: false,
        type: "module",
        bin: { oracle: "bin/oracle.mjs" },
        files: ["bin"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(bin, "oracle.mjs"),
    `#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
const version = ${JSON.stringify(version)};
const mode = ${JSON.stringify(mode)};
const statePath = process.env.ORACLE_ROLLBACK_STATE;
const args = process.argv.slice(2);
if (process.env.ORACLE_ROLLBACK_INJECT_FAILURE === "1") {
  const profile = process.env.ORACLE_ROLLBACK_PROFILE;
  const lockPath = join(profile, "profile.lock");
  mkdirSync(profile, { recursive: true });
  writeFileSync(lockPath, String(process.pid));
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  if (statePath) writeFileSync(statePath, JSON.stringify({ childPid: child.pid, lockPath }));
  try {
    process.stderr.write("INJECTED_FAILURE\\n");
    process.exitCode = 42;
  } finally {
    child.kill();
    rmSync(lockPath, { force: true });
    rmSync(profile, { recursive: true, force: true });
    if (statePath) writeFileSync(statePath, JSON.stringify({ childPid: child.pid, lockPath, cleaned: true }));
  }
} else if (args.includes("--version")) {
  process.stdout.write(version + "\\n");
} else if (args.includes("--help") || args.length === 0) {
  process.stdout.write("oracle rollback fixture " + version + "\\nUsage: oracle [--help|--version|doctor --json]\\n");
} else if (args[0] === "doctor") {
  process.stdout.write(JSON.stringify({ ok: true, mode, version, safe: true }) + "\\n");
} else {
  process.stderr.write("unknown command\\n");
  process.exitCode = 2;
}
`,
    { mode: 0o755 },
  );
}

function packFixture(root, destination) {
  const packed = runNpm(["pack", "--pack-destination", destination], { cwd: root });
  if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr}`);
  const match = packed.stdout.trim().split(/\r?\n/).at(-1)?.trim();
  if (!match || !match.endsWith(".tgz"))
    throw new Error("npm pack did not produce a fixture tarball");
  return join(destination, match);
}

function install(app, tarball) {
  const result = runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
    cwd: app,
  });
  if (result.status !== 0) throw new Error(`npm install failed: ${result.stderr}`);
}

function cliPath(app) {
  return join(app, "node_modules", "oracle-rollback-fixture", "bin", "oracle.mjs");
}

async function waitForProcessExit(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`rollback fixture child process ${pid} remained alive`);
}

export async function runPackagedRollbackSmoke() {
  const root = mkdtempSync(join(tmpdir(), "oracle-packaged-rollback-"));
  const tarballs = join(root, "tarballs");
  const app = join(root, "install");
  const statePath = join(root, "rollback-state.json");
  const profile = join(root, "profile");
  mkdirSync(tarballs, { recursive: true });
  mkdirSync(app, { recursive: true });
  try {
    const current = join(root, "current");
    const previous = join(root, "previous");
    writeFixture(current, CURRENT_VERSION, "current");
    writeFixture(previous, PREVIOUS_VERSION, "previous");
    const currentTarball = packFixture(current, tarballs);
    const previousTarball = packFixture(previous, tarballs);
    const init = runNpm(["init", "-y"], { cwd: app });
    if (init.status !== 0) throw new Error(`npm init failed: ${init.stderr}`);

    install(app, currentTarball);
    const currentCli = cliPath(app);
    const currentVersion = run(process.execPath, [currentCli, "--version"], { cwd: app });
    if (currentVersion.status !== 0 || currentVersion.stdout.trim() !== CURRENT_VERSION)
      throw new Error("current package did not install");

    const failure = run(process.execPath, [currentCli, "run"], {
      cwd: app,
      env: {
        ...process.env,
        ORACLE_ROLLBACK_INJECT_FAILURE: "1",
        ORACLE_ROLLBACK_STATE: statePath,
        ORACLE_ROLLBACK_PROFILE: profile,
      },
    });
    if (failure.status !== 42 || !failure.stderr.includes("INJECTED_FAILURE"))
      throw new Error("injected current-package failure was not observed");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    await waitForProcessExit(state.childPid);
    if (existsSync(state.lockPath) || existsSync(profile))
      throw new Error("rollback left a profile lock");

    install(app, previousTarball);
    const previousCli = cliPath(app);
    const help = run(process.execPath, [previousCli, "--help"], { cwd: app });
    const version = run(process.execPath, [previousCli, "--version"], { cwd: app });
    const doctor = run(process.execPath, [previousCli, "doctor", "--json"], { cwd: app });
    if (help.status !== 0 || !help.stdout.includes("Usage:"))
      throw new Error("restored package help failed");
    if (version.status !== 0 || version.stdout.trim() !== PREVIOUS_VERSION)
      throw new Error("previous package was not restored");
    if (doctor.status !== 0 || JSON.parse(doctor.stdout).safe !== true)
      throw new Error("restored package doctor-safe path failed");
    if (existsSync(profile) || existsSync(state.lockPath))
      throw new Error("restored package left a profile lock");
    return {
      passed: true,
      installCurrent: true,
      injectedFailureObserved: true,
      restoredPrevious: true,
      helpPassed: help.status === 0 && help.stdout.includes("Usage:"),
      versionPassed: version.status === 0 && version.stdout.trim() === PREVIOUS_VERSION,
      doctorPassed: doctor.status === 0 && JSON.parse(doctor.stdout).safe === true,
      currentVersion: currentVersion.stdout.trim(),
      restoredVersion: version.stdout.trim(),
      injectedFailureStatus: failure.status,
      noStaleProcess: true,
      noProfileLock: true,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await runPackagedRollbackSmoke(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  }
}
