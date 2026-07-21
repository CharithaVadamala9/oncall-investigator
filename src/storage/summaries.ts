export interface SummaryReport {
  timestamp: number;
  incidentCount: number;
  summary: string;
}

export interface SummaryReportRow extends SummaryReport {
  id: number;
}

export async function recordSummary(db: D1Database, report: SummaryReport): Promise<void> {
  await db
    .prepare(`INSERT INTO weekly_summaries (timestamp, incident_count, summary) VALUES (?, ?, ?)`)
    .bind(report.timestamp, report.incidentCount, report.summary)
    .run();
}

export async function getRecentSummaries(db: D1Database, limit: number): Promise<SummaryReportRow[]> {
  const result = await db
    .prepare(
      `SELECT id, timestamp, incident_count as incidentCount, summary
       FROM weekly_summaries ORDER BY timestamp DESC LIMIT ?`,
    )
    .bind(limit)
    .all<SummaryReportRow>();
  return result.results;
}
