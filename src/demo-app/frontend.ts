import { getActiveAuthFault } from "../storage/fault-flag";
import { insertLog } from "../storage/logs";
import { handle as handleCheckout } from "./checkout-service";
import type { HopResult } from "./payment-service";

const SERVICE = "frontend";
const OVERHEAD_MIN_MS = 5;
const OVERHEAD_MAX_MS = 15;
const CLIENT_ERROR_RATE = 0.02;
const CLIENT_ERRORS: Array<{ statusCode: number; message: string }> = [
  { statusCode: 400, message: "rejected: malformed request" },
  { statusCode: 401, message: "rejected: expired token" },
  { statusCode: 404, message: "rejected: resource not found" },
  { statusCode: 429, message: "rejected: rate limit exceeded" },
];
const AUTH_ERROR: { statusCode: number; message: string } = CLIENT_ERRORS[1];

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

  // A real incident that happens to be 4xx-shaped (e.g. a broken auth
  // deploy), checked independently of and in addition to the constant
  // background noise below. Deliberately tagged identically to a normal
  // 401 rejection (same statusCode/level/errorType/message) — the only
  // things that differ are the rate and the deploy correlation, which is
  // exactly what should distinguish "real incident" from "background
  // noise" here, not a different tag making it trivially filterable.
  const authFault = await getActiveAuthFault(env.KV, SERVICE);
  if (authFault && Math.random() < authFault.errorRate) {
    await sleep(randomLatency(OVERHEAD_MIN_MS, OVERHEAD_MAX_MS));
    const result: HopResult = {
      statusCode: AUTH_ERROR.statusCode,
      latencyMs: Date.now() - start,
      level: "info",
      errorType: "client_error",
    };
    return record(env, traceId, start, result, AUTH_ERROR.message);
  }

  // Client-side rejections: background noise unrelated to the seeded
  // incident (bad input, expired auth, rate limiting). Short-circuits
  // before checkout-service is ever called, so checkout/payment cannot be
  // affected by construction — and it's tagged level "info" (not "error")
  // so it never inflates infrastructure error-rate metrics.
  if (Math.random() < CLIENT_ERROR_RATE) {
    const picked = CLIENT_ERRORS[Math.floor(Math.random() * CLIENT_ERRORS.length)];
    await sleep(randomLatency(OVERHEAD_MIN_MS, OVERHEAD_MAX_MS));
    const result: HopResult = {
      statusCode: picked.statusCode,
      latencyMs: Date.now() - start,
      level: "info",
      errorType: "client_error",
    };
    return record(env, traceId, start, result, picked.message);
  }

  await sleep(randomLatency(OVERHEAD_MIN_MS, OVERHEAD_MAX_MS));
  const checkoutResult = await handleCheckout(env, traceId);

  const result: HopResult =
    checkoutResult.level === "error"
      ? { statusCode: 500, latencyMs: 0, level: "error", errorType: "downstream_error" }
      : { statusCode: 200, latencyMs: 0, level: "info" };
  result.latencyMs = Date.now() - start;

  return record(
    env,
    traceId,
    start,
    result,
    result.level === "error" ? `request failed (${result.errorType})` : "request completed",
  );
}
