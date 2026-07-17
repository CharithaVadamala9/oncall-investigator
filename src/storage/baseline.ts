export interface Baseline {
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  errorRatePct: number;
}

function key(service: string): string {
  return `baseline:${service}`;
}

export async function setBaseline(kv: KVNamespace, service: string, baseline: Baseline): Promise<void> {
  await kv.put(key(service), JSON.stringify(baseline));
}

export async function getBaseline(kv: KVNamespace, service: string): Promise<Baseline | null> {
  const raw = await kv.get(key(service));
  return raw ? JSON.parse(raw) : null;
}
