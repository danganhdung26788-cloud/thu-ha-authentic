CREATE TABLE IF NOT EXISTS soak_cycles (
  cycle_id text PRIMARY KEY,
  started_on date NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE','PASSED','FAILED')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_soak_cycle
  ON soak_cycles(status)
  WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS soak_days (
  cycle_id text NOT NULL REFERENCES soak_cycles(cycle_id) ON DELETE RESTRICT,
  day_number integer NOT NULL CHECK (day_number BETWEEN 1 AND 7),
  soak_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('PASS','FAIL')),
  evidence jsonb NOT NULL,
  recorded_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(cycle_id, day_number),
  UNIQUE(cycle_id, soak_date)
);

CREATE INDEX IF NOT EXISTS idx_soak_days_cycle
  ON soak_days(cycle_id, day_number);
