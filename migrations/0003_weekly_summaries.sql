CREATE TABLE weekly_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  incident_count INTEGER NOT NULL,
  summary TEXT NOT NULL
);

CREATE INDEX idx_weekly_summaries_timestamp ON weekly_summaries (timestamp);
