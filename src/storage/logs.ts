export interface LogEntry {
  traceId: string;
  service: string;
  timestamp: number;
  level: "info" | "error";
  statusCode: number;
  latencyMs: number;
  errorType?: string;
  message: string;
}

export interface LogRow extends LogEntry {
  id: number;
}

export interface LogCount {
  level: string;
  statusCode: number;
  errorType: string | null;
  count: number;
}

export interface GetLogsParams {
  service: string;
  since: number;
  until: number;
  level?: "info" | "error";
  limit: number;
}

export interface GetLogsResult {
  counts: LogCount[];
  samples: LogRow[];
}

export async function listServices(db: D1Database): Promise<string[]> {
  const result = await db.prepare("SELECT DISTINCT service FROM logs").all<{ service: string }>();
  return result.results.map((row) => row.service);
}

export async function insertLog(db: D1Database, entry: LogEntry): Promise<void> {
  await db
    .prepare(
      `INSERT INTO logs (trace_id, service, timestamp, level, status_code, latency_ms, error_type, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      entry.traceId,
      entry.service,
      entry.timestamp,
      entry.level,
      entry.statusCode,
      entry.latencyMs,
      entry.errorType ?? null,
      entry.message,
    )
    .run();
}

export async function getLogs(db: D1Database, params: GetLogsParams): Promise<GetLogsResult> {
  const levelFilter = params.level ? "AND level = ?" : "";
  const levelArg = params.level ? [params.level] : [];

  const countsQuery = db
    .prepare(
      `SELECT level, status_code as statusCode, error_type as errorType, COUNT(*) as count
       FROM logs
       WHERE service = ? AND timestamp >= ? AND timestamp <= ? ${levelFilter}
       GROUP BY level, status_code, error_type
       ORDER BY count DESC`,
    )
    .bind(params.service, params.since, params.until, ...levelArg);

  const samplesQuery = db
    .prepare(
      `SELECT id, trace_id as traceId, service, timestamp, level, status_code as statusCode,
              latency_ms as latencyMs, error_type as errorType, message
       FROM logs
       WHERE service = ? AND timestamp >= ? AND timestamp <= ? ${levelFilter}
       ORDER BY (level = 'error') DESC, timestamp DESC
       LIMIT ?`,
    )
    .bind(params.service, params.since, params.until, ...levelArg, params.limit);

  const [countsResult, samplesResult] = await Promise.all([
    countsQuery.all<LogCount>(),
    samplesQuery.all<LogRow>(),
  ]);

  return { counts: countsResult.results, samples: samplesResult.results };
}
