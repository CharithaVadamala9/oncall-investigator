CREATE TABLE logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL,
  service TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  level TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  error_type TEXT,
  message TEXT NOT NULL
);

CREATE INDEX idx_logs_service_timestamp ON logs (service, timestamp);
