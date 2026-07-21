export interface IncidentReport {
  timestamp: number;
  symptom: string;
  summary: string;
}

export interface IncidentReportRow extends IncidentReport {
  id: number;
}

export async function recordIncident(db: D1Database, report: IncidentReport): Promise<void> {
  await db
    .prepare(`INSERT INTO incident_reports (timestamp, symptom, summary) VALUES (?, ?, ?)`)
    .bind(report.timestamp, report.symptom, report.summary)
    .run();
}

export async function searchIncidents(
  db: D1Database,
  params: { query?: string; limit: number },
): Promise<IncidentReportRow[]> {
  if (params.query) {
    const like = `%${params.query}%`;
    const result = await db
      .prepare(
        `SELECT id, timestamp, symptom, summary FROM incident_reports
         WHERE symptom LIKE ? OR summary LIKE ?
         ORDER BY timestamp DESC LIMIT ?`,
      )
      .bind(like, like, params.limit)
      .all<IncidentReportRow>();
    return result.results;
  }

  const result = await db
    .prepare(`SELECT id, timestamp, symptom, summary FROM incident_reports ORDER BY timestamp DESC LIMIT ?`)
    .bind(params.limit)
    .all<IncidentReportRow>();
  return result.results;
}
