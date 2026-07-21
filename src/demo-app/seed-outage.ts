import { setOutage } from "../storage/fault-flag";

const SERVICE = "payment-service";
const OUTAGE_DURATION_MS = 10 * 60 * 1000;

export interface SeedOutageResult {
  service: string;
  outageUntil: number;
}

// Deliberately does not write a deploy record — a real silent failure
// (network partition, crashed process, routing misconfiguration) isn't
// always caused by a deploy, unlike the seedIncident scenario.
export async function seedOutage(env: Env): Promise<SeedOutageResult> {
  const outage = await setOutage(env.KV, SERVICE, OUTAGE_DURATION_MS);
  return { service: SERVICE, outageUntil: outage.until };
}
