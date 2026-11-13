-- Pines Budget Sandbox schema. Runs at every start; every statement is safe to repeat.
CREATE TABLE IF NOT EXISTS entities (
  entity_id text PRIMARY KEY, entity_name text NOT NULL, note text
);
CREATE TABLE IF NOT EXISTS departments (
  dept_id text PRIMARY KEY, dept_name text NOT NULL, parent_group_id text, bucket text,
  is_rollup_group boolean NOT NULL DEFAULT false, source text, sort_order integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS accounts (
  account text PRIMARY KEY, name text NOT NULL, type text, pl_section text, revenue_source_system text
);
CREATE TABLE IF NOT EXISTS import_batches (
  id serial PRIMARY KEY, kind text NOT NULL DEFAULT 'GL', file_name text, period_from text, period_to text,
  row_count integer, total_revenue double precision, total_net_income double precision,
  sage_created_on text, period_open boolean NOT NULL DEFAULT true, tieout text,
  created_by text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS import_batch_months (
  batch_id integer NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE, ym text NOT NULL,
  revenue double precision NOT NULL, net_income double precision NOT NULL, PRIMARY KEY (batch_id, ym)
);
CREATE TABLE IF NOT EXISTS actuals (
  id serial PRIMARY KEY, batch_id integer NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  entity_id text NOT NULL, dept_id text, account text NOT NULL, ym text NOT NULL, amount double precision NOT NULL
);
CREATE INDEX IF NOT EXISTS actuals_ym ON actuals (ym, batch_id);
CREATE TABLE IF NOT EXISTS scenarios (
  id serial PRIMARY KEY, name text NOT NULL, kind text NOT NULL DEFAULT 'BUDGET', fiscal_year integer NOT NULL,
  parent_id integer, status text NOT NULL DEFAULT 'DRAFT', locked_by text, locked_at timestamptz,
  notes text, is_sample boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS budget_lines (
  id serial PRIMARY KEY, scenario_id integer NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  entity_id text NOT NULL DEFAULT 'E100', dept_id text NOT NULL, budget_sheet text NOT NULL, account text NOT NULL,
  line_name text NOT NULL, kind text NOT NULL, budget_category text, summary_row text,
  driver_type text NOT NULL DEFAULT 'TYPED', driver_input double precision, is_wage_base boolean NOT NULL DEFAULT false,
  fte_count double precision, fte_hours double precision, fte_rate double precision,
  is_custom boolean NOT NULL DEFAULT false, sort_order integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS budget_lines_scenario ON budget_lines (scenario_id);
CREATE TABLE IF NOT EXISTS line_months (
  line_id integer NOT NULL REFERENCES budget_lines(id) ON DELETE CASCADE, ym text NOT NULL,
  typed double precision, override double precision, PRIMARY KEY (line_id, ym)
);
CREATE TABLE IF NOT EXISTS stat_drivers (
  scenario_id integer NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE, dept_id text NOT NULL DEFAULT '',
  ym text NOT NULL, key text NOT NULL, value double precision, PRIMARY KEY (scenario_id, dept_id, ym, key)
);
-- Read-only history from HMS and Lightspeed ("last year" next to every driver cell).
CREATE TABLE IF NOT EXISTS stat_reference (
  dept_id text NOT NULL DEFAULT '', ym text NOT NULL, key text NOT NULL, value double precision, source text,
  PRIMARY KEY (dept_id, ym, key)
);
CREATE TABLE IF NOT EXISTS adjustments (
  id serial PRIMARY KEY, scenario_id integer NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  label text NOT NULL, enabled boolean NOT NULL DEFAULT true, target_type text NOT NULL DEFAULT 'ALL',
  dept_id text, account text, line_id integer, stat_key text, applies_to text NOT NULL DEFAULT 'BOTH',
  mode text NOT NULL DEFAULT 'PCT', value double precision NOT NULL DEFAULT 0,
  from_month integer NOT NULL DEFAULT 0, to_month integer NOT NULL DEFAULT 11, sort_order integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cash_items (
  scenario_id integer NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE, ym text NOT NULL, item_key text NOT NULL,
  amount double precision, PRIMARY KEY (scenario_id, ym, item_key)
);
CREATE TABLE IF NOT EXISTS cash_notes (
  scenario_id integer NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE, item_key text NOT NULL, note text,
  PRIMARY KEY (scenario_id, item_key)
);
CREATE TABLE IF NOT EXISTS normalizations (
  id serial PRIMARY KEY, label text NOT NULL, account text NOT NULL, dept_id text, ym text NOT NULL,
  amount double precision NOT NULL DEFAULT 0, enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS audit_log (
  id serial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), who text, scenario_id integer, line_id integer,
  ym text, field text NOT NULL, old_value text, new_value text, detail text
);
CREATE INDEX IF NOT EXISTS audit_scenario ON audit_log (scenario_id, id);
CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value text);
