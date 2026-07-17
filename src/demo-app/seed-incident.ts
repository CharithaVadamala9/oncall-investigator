import { addDeploy } from "../storage/deploys";
import { setFault } from "../storage/fault-flag";

const SERVICE = "payment-service";
const DEPLOY_LEAD_MS = 5 * 60 * 1000;
const FAULT_DURATION_MS = 10 * 60 * 1000;
const FAULT_LATENCY_MS = 2000;
const FAULT_ERROR_RATE = 0.25;

export interface SeedIncidentResult {
  service: string;
  deployTimestamp: number;
  faultUntil: number;
}

export async function seedIncident(env: Env): Promise<SeedIncidentResult> {
  const now = Date.now();
  const deployTimestamp = now - DEPLOY_LEAD_MS;

  await addDeploy(env.KV, SERVICE, {
    timestamp: deployTimestamp,
    version: "v1.4.2",
    description: "payment-service: connection pool resize",
  });

  const fault = await setFault(env.KV, SERVICE, {
    durationMs: FAULT_DURATION_MS,
    latencyMs: FAULT_LATENCY_MS,
    errorRate: FAULT_ERROR_RATE,
  });

  return { service: SERVICE, deployTimestamp, faultUntil: fault.until };
}
