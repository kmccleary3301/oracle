import http from "node:http";
import { readFile } from "node:fs/promises";
import type {
  OracleDaemonConnection,
  OracleDaemonJobRequest,
  OracleDaemonJobStartResponse,
} from "./types.js";

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

  async listJobs(limit?: number): Promise<unknown> {
    return await this.request("GET", `/jobs${limit ? `?limit=${limit}` : ""}`);
  }

  async jobStatus(jobId: string): Promise<unknown> {
    return await this.request("GET", `/jobs/${encodeURIComponent(jobId)}`);
  }

  async jobEvents(jobId: string, after?: number): Promise<unknown> {
    return await this.request(
      "GET",
      `/jobs/${encodeURIComponent(jobId)}/events${after ? `?after=${after}` : ""}`,
    );
  }

  async jobResult(jobId: string): Promise<unknown> {
    return await this.request("GET", `/jobs/${encodeURIComponent(jobId)}/result`);
  }

  async cancelJob(jobId: string): Promise<unknown> {
    return await this.request("POST", `/jobs/${encodeURIComponent(jobId)}/cancel`, {});
  }

  async recoverJob(jobId: string, input?: unknown): Promise<unknown> {
    return await this.request("POST", `/jobs/${encodeURIComponent(jobId)}/recover`, input ?? {});
  }

  async stopDaemon(): Promise<unknown> {
    return await this.request("POST", "/daemon/stop", {});
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return await new Promise((resolve, reject) => {
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
          res.on("data", (chunk: Buffer | string) => {
            chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
          });
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: unknown = {};
            try {
              parsed = raw ? JSON.parse(raw) : {};
            } catch {
              parsed = { raw };
            }
            if ((res.statusCode ?? 500) >= 400) {
              reject(new Error(extractErrorMessage(parsed, res.statusCode ?? 500)));
              return;
            }
            resolve(parsed);
          });
        },
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
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
