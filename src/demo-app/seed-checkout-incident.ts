import { addDeploy } from "../storage/deploys";
import { setFault } from "../storage/fault-flag";

const SERVICE = "checkout-service";
const DEPLOY_LEAD_MS = 5 * 60 * 1000;
const FAULT_DURATION_MS = 10 * 60 * 1000;
const FAULT_LATENCY_MS = 900;
const FAULT_ERROR_RATE = 0.15;

export interface SeedCheckoutIncidentResult {
  service: string;
  deployTimestamp: number;
  faultUntil: number;
}

export async function seedCheckoutIncident(env: Env): Promise<SeedCheckoutIncidentResult> {
  const now = Date.now();
  const deployTimestamp = now - DEPLOY_LEAD_MS;

  await addDeploy(env.KV, SERVICE, {
    timestamp: deployTimestamp,
    version: "v3.0.1",
    description: "checkout-service: synchronous inventory check added to cart validation",
  });

  const fault = await setFault(env.KV, SERVICE, {
    durationMs: FAULT_DURATION_MS,
    latencyMs: FAULT_LATENCY_MS,
    errorRate: FAULT_ERROR_RATE,
  });

  return { service: SERVICE, deployTimestamp, faultUntil: fault.until };
}
