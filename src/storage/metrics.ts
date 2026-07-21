// Must match wrangler.toml's [[analytics_engine_datasets]] `dataset` value —
// the AnalyticsEngineDataset binding type has no way to introspect its own
// dataset name at runtime, and the SQL API has no notion of "the binding",
// only the literal dataset name in the FROM clause. A prior version of this
// file hardcoded "oncall_metrics" directly in the query; when the dataset
// was later renamed to "oncall_metrics_v2" in wrangler.toml to escape
// permanently-accumulated test residue, only the write path picked up the
// change (writeDataPoint goes through the binding) — this read path kept
// querying the old, still-polluted dataset until this constant was pulled
// out and updated to match. Change both together from now on.
const DATASET_NAME = "oncall_metrics_v2";

export interface MetricsResult {
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  errorRate: number;
  requestCount: number;
}

// ClickHouse's FORMAT JSON stringifies UInt64 columns (like sum() results)
// to avoid precision loss, while Float64 columns (like quantiles) come back
// as real JSON numbers — so this response is a genuine string/number mix,
// confirmed against a live query rather than assumed from docs.
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

// Caller (tools.ts) validates `service` against a strict pattern before this
// runs — the value is interpolated directly into a raw SQL string because
// the Analytics Engine SQL API takes plain-text SQL, not parameterized queries.
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
