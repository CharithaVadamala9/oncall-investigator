import { insertLog } from "../storage/logs";
import { getActiveFault } from "../storage/fault-flag";

export interface HopResult {
  statusCode: number;
  latencyMs: number;
  level: "info" | "error";
  errorType?: string;
}

const SERVICE = "payment-service";
const BASELINE_MIN_LATENCY_MS = 15;
const BASELINE_MAX_LATENCY_MS = 45;
const BASELINE_ERROR_RATE = 0.005;

function randomLatency(min: number, max: number): number {
  return Math.round(min + Math.random() * (max - min));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function handle(env: Env, traceId: string): Promise<HopResult> {
  const start = Date.now();
  const fault = await getActiveFault(env.KV, SERVICE);

  const latencyMs = fault
    ? fault.latencyMs
    : randomLatency(BASELINE_MIN_LATENCY_MS, BASELINE_MAX_LATENCY_MS);
  await sleep(latencyMs);

  const errorRate = fault ? fault.errorRate : BASELINE_ERROR_RATE;
  const failed = Math.random() < errorRate;

  const result: HopResult = failed
    ? { statusCode: 500, latencyMs: Date.now() - start, level: "error", errorType: "internal_error" }
    : { statusCode: 200, latencyMs: Date.now() - start, level: "info" };

  await insertLog(env.oncall_investigator_db, {
    traceId,
    service: SERVICE,
    timestamp: start,
    level: result.level,
    statusCode: result.statusCode,
    latencyMs: result.latencyMs,
    errorType: result.errorType,
    message: result.level === "error" ? `payment failed (${result.errorType})` : "payment processed",
  });

  env.METRICS.writeDataPoint({
    indexes: [SERVICE],
    blobs: [result.level],
    doubles: [result.latencyMs, result.statusCode],
  });

  return result;
}
