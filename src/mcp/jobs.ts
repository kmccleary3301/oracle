import type { OracleDaemonJobStartResponse } from "../daemon/types.js";
import { requireDaemonClientWithOptionalAutostart } from "../daemon/resolve.js";
import type { OracleJobKind } from "../jobs/types.js";

export async function startMcpJob(
  kind: OracleJobKind,
  input: unknown,
): Promise<OracleDaemonJobStartResponse> {
  const daemon = await requireDaemonClientWithOptionalAutostart();
  return await daemon.startJob({ kind, input });
}
