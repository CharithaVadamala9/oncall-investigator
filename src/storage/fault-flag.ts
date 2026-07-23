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

// "Unreachable" — checked by the caller before attempting the call — as
// opposed to setFault above, checked by the service itself after being
// called. Binary: no latency/error-rate, since the call never happens.
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

export interface AuthFaultConfig {
  errorRate: number;
  until: number;
}

// An elevated rate of one specific client-error code, layered on top of
// (not instead of) the constant background noise in frontend.ts — an auth
// bug wouldn't suppress unrelated normal client behavior like rate limiting.
function authFaultKey(service: string): string {
  return `auth-fault:${service}`;
}

export async function setAuthFault(
  kv: KVNamespace,
  service: string,
  opts: { durationMs: number; errorRate: number },
): Promise<AuthFaultConfig> {
  const config: AuthFaultConfig = { errorRate: opts.errorRate, until: Date.now() + opts.durationMs };
  await kv.put(authFaultKey(service), JSON.stringify(config));
  return config;
}

export async function getActiveAuthFault(kv: KVNamespace, service: string): Promise<AuthFaultConfig | null> {
  const raw = await kv.get(authFaultKey(service));
  if (!raw) return null;
  const config: AuthFaultConfig = JSON.parse(raw);
  return config.until > Date.now() ? config : null;
}
