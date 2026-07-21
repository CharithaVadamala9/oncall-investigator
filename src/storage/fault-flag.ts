export interface FaultConfig {
  latencyMs: number;
  errorRate: number;
  until: number;
}

function key(service: string): string {
  return `fault:${service}`;
}

export async function setFault(
  kv: KVNamespace,
  service: string,
  opts: { durationMs: number; latencyMs: number; errorRate: number },
): Promise<FaultConfig> {
  const config: FaultConfig = {
    latencyMs: opts.latencyMs,
    errorRate: opts.errorRate,
    until: Date.now() + opts.durationMs,
  };
  await kv.put(key(service), JSON.stringify(config));
  return config;
}

// Expired configs are treated as absent rather than deleted eagerly —
// the next setFault() call overwrites the key anyway, and reads are cheap.
export async function getActiveFault(kv: KVNamespace, service: string): Promise<FaultConfig | null> {
  const raw = await kv.get(key(service));
  if (!raw) return null;
  const config: FaultConfig = JSON.parse(raw);
  return config.until > Date.now() ? config : null;
}

export async function clearFault(kv: KVNamespace, service: string): Promise<void> {
  await kv.delete(key(service));
}

// A distinct flag from setFault/getActiveFault above: "this service is
// unreachable" (checked by the *caller*, before it ever attempts the call)
// rather than "this service is slow/erroring" (checked by the service
// itself, after it's already been called). Binary — no latency/error-rate
// parameters, since the point is the call never happens at all.
function outageKey(service: string): string {
  return `outage:${service}`;
}

export async function setOutage(kv: KVNamespace, service: string, durationMs: number): Promise<{ until: number }> {
  const config = { until: Date.now() + durationMs };
  await kv.put(outageKey(service), JSON.stringify(config));
  return config;
}

export async function isOutageActive(kv: KVNamespace, service: string): Promise<boolean> {
  const raw = await kv.get(outageKey(service));
  if (!raw) return false;
  const config: { until: number } = JSON.parse(raw);
  return config.until > Date.now();
}

export async function clearOutage(kv: KVNamespace, service: string): Promise<void> {
  await kv.delete(outageKey(service));
}
