import { getActiveFault, isOutageActive } from "../storage/fault-flag";
import { insertLog } from "../storage/logs";
import { handle as handlePayment, type HopResult } from "./payment-service";

const SERVICE = "checkout-service";
const DOWNSTREAM = "payment-service";
const TIMEOUT_MS = 1500;
const OVERHEAD_MIN_MS = 5;
const OVERHEAD_MAX_MS = 15;

function randomLatency(min: number, max: number): number {
  return Math.round(min + Math.random() * (max - min));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function record(
  env: Env,
  traceId: string,
  start: number,
  result: HopResult,
  message: string,
): Promise<HopResult> {
  await insertLog(env.oncall_investigator_db, {
    traceId,
    service: SERVICE,
    timestamp: start,
    level: result.level,
    statusCode: result.statusCode,
    latencyMs: result.latencyMs,
    errorType: result.errorType,
    message,
  });

  env.METRICS.writeDataPoint({
    indexes: [SERVICE],
    blobs: [result.level],
    doubles: [result.latencyMs, result.statusCode],
  });

  return result;
}

export async function handle(env: Env, traceId: string): Promise<HopResult> {
  const start = Date.now();

  // checkout-service's own bug/regression — unrelated to payment-service
  // entirely. When active, adds its own latency (in place of the normal
  // small overhead) before ever calling payment-service, and can fail
  // outright without calling it at all. errorType "internal_error" (not
  // "downstream_*") mirrors the same label payment-service already uses
  // for its own bugs — this service's fault is its own, not inherited.
  const ownFault = await getActiveFault(env.KV, SERVICE);
  if (ownFault) {
    await sleep(ownFault.latencyMs);
    if (Math.random() < ownFault.errorRate) {
      const result: HopResult = {
        statusCode: 500,
        latencyMs: Date.now() - start,
        level: "error",
        errorType: "internal_error",
      };
      return record(env, traceId, start, result, "checkout failed (internal_error)");
    }
  } else {
    await sleep(randomLatency(OVERHEAD_MIN_MS, OVERHEAD_MAX_MS));
  }

  // Outage: payment-service is unreachable entirely (network partition,
  // crashed process, routing misconfiguration — not "slow", just gone).
  // checkout-service never even attempts the call, so payment-service
  // produces zero log rows for this request — a fast failure with an
  // absence of downstream data, not a slow one with error data.
  if (await isOutageActive(env.KV, DOWNSTREAM)) {
    const result: HopResult = {
      statusCode: 503,
      latencyMs: Date.now() - start,
      level: "error",
      errorType: "connection_refused",
    };
    return record(env, traceId, start, result, `checkout failed (${result.errorType}) — payment-service unreachable`);
  }

  const paymentResult = await handlePayment(env, traceId);

  let result: HopResult;
  if (paymentResult.latencyMs > TIMEOUT_MS) {
    result = { statusCode: 504, latencyMs: 0, level: "error", errorType: "downstream_timeout" };
  } else if (paymentResult.statusCode >= 500) {
    result = { statusCode: 502, latencyMs: 0, level: "error", errorType: "downstream_5xx" };
  } else {
    result = { statusCode: 200, latencyMs: 0, level: "info" };
  }
  result.latencyMs = Date.now() - start;

  return record(
    env,
    traceId,
    start,
    result,
    result.level === "error" ? `checkout failed (${result.errorType})` : "checkout completed",
  );
}
