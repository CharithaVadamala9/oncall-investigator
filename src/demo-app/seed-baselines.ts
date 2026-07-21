import { setBaseline, type Baseline } from "../storage/baseline";

const BASELINES: Record<string, Baseline> = {
  "payment-service": { p50LatencyMs: 30, p95LatencyMs: 44, p99LatencyMs: 45, errorRatePct: 0.5 },
  "checkout-service": { p50LatencyMs: 40, p95LatencyMs: 58, p99LatencyMs: 60, errorRatePct: 0 },
  frontend: { p50LatencyMs: 50, p95LatencyMs: 73, p99LatencyMs: 75, errorRatePct: 2 },
};

export async function seedBaselines(env: Env): Promise<void> {
  await Promise.all(
    Object.entries(BASELINES).map(([service, baseline]) => setBaseline(env.KV, service, baseline)),
  );
}
