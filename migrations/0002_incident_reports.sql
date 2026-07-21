CREATE TABLE incident_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  symptom TEXT NOT NULL,
  summary TEXT NOT NULL
);

CREATE INDEX idx_incident_reports_timestamp ON incident_reports (timestamp);
