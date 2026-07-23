// Must match wrangler.toml's analytics_engine_datasets `dataset` value. The
// binding has no way to introspect its own name at runtime, and the SQL API
// only accepts a literal table name, so this is hand-synced rather than
// derived — keep both in sync when renaming the dataset.
const DATASET_NAME = "oncall_metrics_v2";

export interface MetricsResult {
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  errorRate: number;
  requestCount: number;
}

// ClickHouse's FORMAT JSON stringifies UInt64 sums to avoid precision loss;
// Float64 quantiles come back as real numbers — a genuine string/number
// mix, not an inconsistency.
interface AnalyticsEngineRow {
  p50: number | string | null;
  p95: number | string | null;
  p99: number | string | null;
  errorRate: number | string | null;
  requestCount: number | string | null;
}

interface AnalyticsEngineResponse {
  data: AnalyticsEngineRow[];
}

// `service` is validated by the caller (tools.ts) before this runs — it's
// interpolated directly into raw SQL since the AE SQL API takes plain text,
// not parameterized queries.
export async function queryMetrics(
  env: Env,
  service: string,
  windowMinutes: number,
): Promise<MetricsResult | null> {
  const sql = `
    SELECT
      quantileExactWeighted(0.5)(double1, _sample_interval) AS p50,
      quantileExactWeighted(0.95)(double1, _sample_interval) AS p95,
      quantileExactWeighted(0.99)(double1, _sample_interval) AS p99,
      sum(if(blob1 = 'error', _sample_interval, 0)) / sum(_sample_interval) AS errorRate,
      sum(_sample_interval) AS requestCount
    FROM ${DATASET_NAME}
    WHERE index1 = '${service}' AND timestamp > NOW() - INTERVAL '${windowMinutes}' MINUTE
    FORMAT JSON
  `;

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
      body: sql,
    },
  );

  if (!response.ok) {
    throw new Error(`Analytics Engine query failed: ${response.status} ${await response.text()}`);
  }

  const body = await response.json<AnalyticsEngineResponse>();
  const row = body.data?.[0];
  const requestCount = row ? Number(row.requestCount ?? 0) : 0;

  if (!row || requestCount === 0) {
    return null;
  }

  return {
    p50LatencyMs: Number(row.p50 ?? 0),
    p95LatencyMs: Number(row.p95 ?? 0),
    p99LatencyMs: Number(row.p99 ?? 0),
    errorRate: Number(row.errorRate ?? 0),
    requestCount,
  };
}
