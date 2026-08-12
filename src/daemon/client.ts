import http from "node:http";
import { readFile } from "node:fs/promises";
import type {
  OracleJobEvent,
  OracleJobRecord,
  OracleJobResultResponse,
  OracleJobStatusResponse,
} from "../jobs/types.js";
import type {
  OracleDaemonConnection,
  OracleDaemonJobRequest,
  OracleDaemonJobStartResponse,
  OracleDaemonWorkInput,
  OracleDaemonWorkResult,
} from "./types.js";

const MAX_DAEMON_RESPONSE_BYTES = 64 * 1024 * 1024;
export interface OracleDaemonClientOptions {
  host: string;
  port: number;
  token: string;
}

export class OracleDaemonClient {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  constructor(options: OracleDaemonClientOptions) {
    this.host = options.host;
    this.port = options.port;
    this.token = options.token;
  }

  async status(): Promise<unknown> {
    return await this.request("GET", "/daemon/status");
  }

  async startJob(request: OracleDaemonJobRequest): Promise<OracleDaemonJobStartResponse> {
    return (await this.request("POST", "/jobs", request)) as OracleDaemonJobStartResponse;
  }

  async workStart(input: OracleDaemonWorkInput): Promise<OracleDaemonJobStartResponse> {
    return (await this.request("POST", "/work/start", input)) as OracleDaemonJobStartResponse;
  }

  async workStatus(input: OracleDaemonWorkInput): Promise<OracleDaemonWorkResult> {
    return (await this.request("POST", "/work/status", input)) as OracleDaemonWorkResult;
  }

  async workAnswer(input: OracleDaemonWorkInput): Promise<OracleDaemonWorkResult> {
    return (await this.request("POST", "/work/answer", input)) as OracleDaemonWorkResult;
  }

  async workApprove(input: OracleDaemonWorkInput): Promise<OracleDaemonWorkResult> {
    return (await this.request("POST", "/work/approve", input)) as OracleDaemonWorkResult;
  }

  async workInterrupt(input: OracleDaemonWorkInput): Promise<OracleDaemonWorkResult> {
    return (await this.request("POST", "/work/interrupt", input)) as OracleDaemonWorkResult;
  }

  async listJobs(limit?: number): Promise<{ jobs: OracleJobRecord[] }> {
    return (await this.request("GET", `/jobs${limit ? `?limit=${limit}` : ""}`)) as {
      jobs: OracleJobRecord[];
    };
  }

  async jobStatus(jobId: string): Promise<OracleJobStatusResponse> {
    return (await this.request(
      "GET",
      `/jobs/${encodeURIComponent(jobId)}`,
    )) as OracleJobStatusResponse;
  }

  async jobEvents(
    jobId: string,
    after?: number,
  ): Promise<{
    found: boolean;
    events: OracleJobEvent[];
  }> {
    return (await this.request(
      "GET",
      `/jobs/${encodeURIComponent(jobId)}/events${after !== undefined ? `?after=${after}` : ""}`,
    )) as { found: boolean; events: OracleJobEvent[] };
  }

  async jobResult(jobId: string): Promise<OracleJobResultResponse> {
    return (await this.request(
      "GET",
      `/jobs/${encodeURIComponent(jobId)}/result`,
    )) as OracleJobResultResponse;
  }

  async cancelJob(jobId: string): Promise<{
    found: boolean;
    job?: OracleJobRecord;
  }> {
    return (await this.request("POST", `/jobs/${encodeURIComponent(jobId)}/cancel`, {})) as {
      found: boolean;
      job?: OracleJobRecord;
    };
  }

  async recoverJob(jobId: string, input?: unknown): Promise<unknown> {
    return await this.request("POST", `/jobs/${encodeURIComponent(jobId)}/recover`, input ?? {});
  }

  async stopDaemon(): Promise<unknown> {
    return await this.request("POST", "/daemon/stop", {});
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    let resolvePromise!: (value: unknown) => void;
    let rejectPromise!: (reason?: unknown) => void;
    const promise = new Promise<unknown>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const req = http.request(
      {
        hostname: this.host,
        port: this.port,
        path,
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": payload.length }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        res.on("data", (chunk: Buffer | string) => {
          const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          receivedBytes += buffer.length;
          if (receivedBytes > MAX_DAEMON_RESPONSE_BYTES) {
            res.destroy(
              new Error(`Oracle daemon response exceeded ${MAX_DAEMON_RESPONSE_BYTES} bytes.`),
            );
            return;
          }
          chunks.push(buffer);
        });
        res.on("error", rejectPromise);
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = {};
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch {
            parsed = { raw };
          }
          if ((res.statusCode ?? 500) >= 400) {
            rejectPromise(new Error(extractErrorMessage(parsed, res.statusCode ?? 500)));
            return;
          }
          resolvePromise(parsed);
        });
      },
    );
    req.on("error", rejectPromise);
    if (payload) req.write(payload);
    req.end();
    return await promise;
  }
}

export async function readDaemonConnectionArtifact(
  filePath: string,
): Promise<OracleDaemonConnection | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as OracleDaemonConnection;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
  }
}

export function createDaemonClientFromConnection(
  connection: OracleDaemonConnection,
): OracleDaemonClient {
  return new OracleDaemonClient({
    host: connection.host,
    port: connection.port,
    token: connection.token,
  });
}

function extractErrorMessage(value: unknown, statusCode: number): string {
  if (value && typeof value === "object" && "error" in value) {
    return String((value as { error?: unknown }).error);
  }
  return `Oracle daemon responded with status ${statusCode}`;
}
