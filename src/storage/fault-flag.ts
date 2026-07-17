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
