import { insertLog } from "../storage/logs";
import { handle as handleCheckout } from "./checkout-service";
import type { HopResult } from "./payment-service";

const SERVICE = "frontend";
const OVERHEAD_MIN_MS = 5;
const OVERHEAD_MAX_MS = 15;

function randomLatency(min: number, max: number): number {
  return Math.round(min + Math.random() * (max - min));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function handle(env: Env, traceId: string): Promise<HopResult> {
  const start = Date.now();
  await sleep(randomLatency(OVERHEAD_MIN_MS, OVERHEAD_MAX_MS));

  const checkoutResult = await handleCheckout(env, traceId);

  const result: HopResult =
    checkoutResult.level === "error"
      ? { statusCode: 500, latencyMs: 0, level: "error", errorType: "downstream_error" }
      : { statusCode: 200, latencyMs: 0, level: "info" };
  result.latencyMs = Date.now() - start;

  await insertLog(env.oncall_investigator_db, {
    traceId,
    service: SERVICE,
    timestamp: start,
    level: result.level,
    statusCode: result.statusCode,
    latencyMs: result.latencyMs,
    errorType: result.errorType,
    message: result.level === "error" ? `request failed (${result.errorType})` : "request completed",
  });

  env.METRICS.writeDataPoint({
    indexes: [SERVICE],
    blobs: [result.level],
    doubles: [result.latencyMs, result.statusCode],
  });

  return result;
}
