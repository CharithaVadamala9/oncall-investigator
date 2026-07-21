import { addDeploy } from "../storage/deploys";
import { setAuthFault } from "../storage/fault-flag";

const SERVICE = "frontend";
const DEPLOY_LEAD_MS = 5 * 60 * 1000;
const FAULT_DURATION_MS = 10 * 60 * 1000;
const FAULT_ERROR_RATE = 0.35;

export interface SeedAuthIncidentResult {
  service: string;
  deployTimestamp: number;
  faultUntil: number;
}

export async function seedAuthIncident(env: Env): Promise<SeedAuthIncidentResult> {
  const now = Date.now();
  const deployTimestamp = now - DEPLOY_LEAD_MS;

  await addDeploy(env.KV, SERVICE, {
    timestamp: deployTimestamp,
    version: "v2.1.0",
    description: "frontend: token refresh middleware update",
  });

  const fault = await setAuthFault(env.KV, SERVICE, {
    durationMs: FAULT_DURATION_MS,
    errorRate: FAULT_ERROR_RATE,
  });

  return { service: SERVICE, deployTimestamp, faultUntil: fault.until };
}
