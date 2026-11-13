// Loading, copying and computing scenarios on the server (same engine as the screens).
import { q, tx, insertMany, type Q } from './db';
import {
  computeScenario, summarizeScenario, computeCash, emptyStats, nulls, zeros,
  type Line, type Stats, type Adjustment, type EngineOptions, type Opt12, type DriverType,
} from '../shared/calc';

export class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export async function getSettings(qq: Q = q): Promise<Record<string, string>> {
  const rows = await qq<{ key: string; value: string }>('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
export function optionsFrom(s: Record<string, string>): EngineOptions {
  return { roomsDept: s.rooms_dept || '20', roomRevAccounts: (s.room_rev_accounts || '4001,4002').split(',').map((x) => x.trim()).filter(Boolean) };
}

const LATEST = `WITH latest AS (SELECT ym, max(batch_id) AS batch_id FROM actuals GROUP BY ym)`;
export async function actualsBetween(from: string, to: string, qq: Q = q) {
  return qq<{ entity_id: string; dept_id: string | null; account: string; ym: string; amount: number }>(
    `${LATEST} SELECT a.entity_id, a.dept_id, a.account, a.ym, sum(a.amount)::float8 AS amount
     FROM actuals a JOIN latest l ON l.ym = a.ym AND l.batch_id = a.batch_id
     WHERE a.ym >= $1 AND a.ym <= $2 GROUP BY 1,2,3,4`, [from, to]);
}

export interface Bundle {
  scenario: any; lines: Line[]; stats: Stats; adjustments: Adjustment[];
  cash: Record<string, Opt12>; cashNotes: Record<string, string>; options: EngineOptions;
}

export async function loadBundle(id: number, qq: Q = q): Promise<Bundle> {
  const [scenario] = await qq('SELECT * FROM scenarios WHERE id=$1', [id]);
  if (!scenario) throw new HttpError(404, 'Scenario not found');
  const fy: number = scenario.fiscal_year;
  const settings = await getSettings(qq);
  const options = optionsFrom(settings);
  const mIdx = (ym: string) => Number(ym.slice(5, 7)) - 1;

  const [lineRows, monthRows, statRows, adjRows, cashRows, noteRows, payrollAccounts, py, norms] = await Promise.all([
    qq('SELECT * FROM budget_lines WHERE scenario_id=$1 ORDER BY sort_order, id', [id]),
    qq(`SELECT m.* FROM line_months m JOIN budget_lines b ON b.id=m.line_id WHERE b.scenario_id=$1 AND m.ym LIKE $2`, [id, `${fy}-%`]),
    qq('SELECT * FROM stat_drivers WHERE scenario_id=$1 AND ym LIKE $2', [id, `${fy}-%`]),
    qq('SELECT * FROM adjustments WHERE scenario_id=$1 ORDER BY sort_order, id', [id]),
    qq('SELECT * FROM cash_items WHERE scenario_id=$1 AND ym LIKE $2', [id, `${fy}-%`]),
    qq('SELECT * FROM cash_notes WHERE scenario_id=$1', [id]),
    qq<{ account: string }>(`SELECT account FROM accounts WHERE pl_section ILIKE 'payroll%'`),
    actualsBetween(`${fy - 1}-01`, `${fy - 1}-12`, qq),
    qq(`SELECT * FROM normalizations WHERE enabled AND ym LIKE $1`, [`${fy - 1}-%`]),
  ]);

  const payroll = new Set(payrollAccounts.map((a) => a.account));
  const isPayroll = (acct: string) => payroll.has(acct) || (acct >= '6001' && acct <= '6019');
  const pyMap = new Map<string, Opt12>();
  for (const r of py) {
    const k = `${r.entity_id}|${r.dept_id ?? ''}|${r.account}`;
    if (!pyMap.has(k)) pyMap.set(k, nulls());
    const arr = pyMap.get(k)!;
    arr[mIdx(r.ym)] = (arr[mIdx(r.ym)] ?? 0) + r.amount;
  }
  const byId = new Map<number, Line>();
  const lines: Line[] = lineRows.map((r: any) => {
    let pyArr = pyMap.get(`${r.entity_id}|${r.dept_id}|${r.account}`);
    if (pyArr) {
      pyArr = [...pyArr];
      // one-time items switched on are taken out of last year's base
      for (const n of norms) {
        if (n.account === r.account && (!n.dept_id || n.dept_id === r.dept_id)) {
          const m = mIdx(n.ym);
          pyArr[m] = (pyArr[m] ?? 0) - n.amount;
        }
      }
    }
    const l: Line = {
      id: r.id, entityId: r.entity_id, deptId: r.dept_id, sheet: r.budget_sheet, account: r.account, name: r.line_name,
      kind: r.kind, summaryRow: r.summary_row ?? '', category: r.budget_category ?? '', driverType: r.driver_type as DriverType,
      driverInput: r.driver_input, isWageBase: r.is_wage_base, isPayroll: r.kind === 'COST' && isPayroll(r.account), isCustom: r.is_custom,
      fteCount: r.fte_count, fteHours: r.fte_hours, fteRate: r.fte_rate, typed: nulls(), override: nulls(), py: pyArr, sort: r.sort_order,
    };
    byId.set(l.id, l);
    return l;
  });
  for (const m of monthRows) {
    const l = byId.get(m.line_id);
    if (!l) continue;
    l.typed[mIdx(m.ym)] = m.typed;
    l.override[mIdx(m.ym)] = m.override;
  }
  const stats = emptyStats(fy, Number(settings.room_count) || 106);
  for (const s of statRows) {
    const m = mIdx(s.ym);
    const v = Number(s.value ?? 0) || 0;
    if (s.dept_id === '') {
      if (s.key === 'rooms_sold') stats.roomsSold[m] = v;
      else if (s.key === 'adr') stats.adr[m] = v;
      else if (s.key === 'ooo_room_nights') stats.ooo[m] = v;
    } else {
      const t = s.key === 'covers' ? stats.covers : s.key === 'avg_check' ? stats.avgCheck : s.key === 'occ_rooms' ? stats.occRooms : null;
      if (t) { (t[s.dept_id] ??= zeros())[m] = v; }
    }
  }
  const adjustments: Adjustment[] = adjRows.map((a: any) => ({
    id: a.id, label: a.label, enabled: a.enabled, targetType: a.target_type, deptId: a.dept_id, account: a.account, lineId: a.line_id,
    statKey: a.stat_key, appliesTo: a.applies_to, mode: a.mode, value: a.value, fromMonth: a.from_month, toMonth: a.to_month,
  }));
  const cash: Record<string, Opt12> = {};
  for (const c of cashRows) (cash[c.item_key] ??= nulls())[mIdx(c.ym)] = c.amount;
  const cashNotes = Object.fromEntries(noteRows.map((n: any) => [n.item_key, n.note ?? '']));
  return { scenario, lines, stats, adjustments, cash, cashNotes, options };
}

export function computeBundle(b: Bundle) {
  const result = computeScenario(b.lines, b.stats, b.adjustments, b.options);
  const summary = summarizeScenario(b.lines, result.byLine);
  const cash = computeCash(b.cash, summary.ebitda, summary.interest);
  return { result, summary, cash };
}

export async function assertUnlocked(scenarioId: number, qq: Q = q) {
  const [s] = await qq('SELECT status FROM scenarios WHERE id=$1', [scenarioId]);
  if (!s) throw new HttpError(404, 'Scenario not found');
  if (s.status === 'LOCKED') throw new HttpError(423, 'This scenario is locked. Unlock it or save it as a new scenario.');
}

export async function audit(qq: Q, who: string, scenarioId: number | null, field: string, oldV: any, newV: any,
  extra: { lineId?: number | null; ym?: string | null; detail?: string } = {}) {
  const s = (v: any) => (v === null || v === undefined ? null : String(v));
  if (s(oldV) === s(newV)) return;
  await qq(`INSERT INTO audit_log (who, scenario_id, line_id, ym, field, old_value, new_value, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [who, scenarioId, extra.lineId ?? null, extra.ym ?? null, field, s(oldV), s(newV), extra.detail ?? null]);
}

/** Copy a scenario with all lines, months, drivers, levers and cash rows. */
export async function copyScenario(srcId: number, name: string, opts: { kind?: string; parentId?: number | null; fiscalYear?: number } = {}) {
  return tx(async (qq) => {
    const [src] = await qq('SELECT * FROM scenarios WHERE id=$1', [srcId]);
    if (!src) throw new HttpError(404, 'Scenario not found');
    const fy = opts.fiscalYear || src.fiscal_year;
    const reYm = (ym: string) => `${fy}${ym.slice(4)}`;
    const [{ id }] = await qq(`INSERT INTO scenarios (name, kind, fiscal_year, parent_id, status, is_sample) VALUES ($1,$2,$3,$4,'DRAFT',$5) RETURNING id`,
      [name, opts.kind || src.kind, fy, opts.parentId === undefined ? srcId : opts.parentId, !!src.is_sample]);
    const lines = await qq('SELECT * FROM budget_lines WHERE scenario_id=$1 ORDER BY sort_order, id', [srcId]);
    const cols = ['entity_id', 'dept_id', 'budget_sheet', 'account', 'line_name', 'kind', 'budget_category', 'summary_row', 'driver_type',
      'driver_input', 'is_wage_base', 'fte_count', 'fte_hours', 'fte_rate', 'is_custom', 'sort_order'];
    const newIds = await insertMany(qq, 'budget_lines', ['scenario_id', ...cols], lines.map((l: any) => [id, ...cols.map((c) => l[c])]), 'RETURNING id');
    const map = new Map<number, number>(lines.map((l: any, i: number) => [l.id, newIds[i].id]));
    const months = await qq(`SELECT m.* FROM line_months m JOIN budget_lines b ON b.id=m.line_id WHERE b.scenario_id=$1 AND m.ym LIKE $2`, [srcId, `${src.fiscal_year}-%`]);
    await insertMany(qq, 'line_months', ['line_id', 'ym', 'typed', 'override'], months.map((m: any) => [map.get(m.line_id), reYm(m.ym), m.typed, m.override]));
    const stats = await qq('SELECT * FROM stat_drivers WHERE scenario_id=$1 AND ym LIKE $2', [srcId, `${src.fiscal_year}-%`]);
    await insertMany(qq, 'stat_drivers', ['scenario_id', 'dept_id', 'ym', 'key', 'value'], stats.map((s: any) => [id, s.dept_id, reYm(s.ym), s.key, s.value]));
    const adjs = await qq('SELECT * FROM adjustments WHERE scenario_id=$1 ORDER BY sort_order, id', [srcId]);
    await insertMany(qq, 'adjustments', ['scenario_id', 'label', 'enabled', 'target_type', 'dept_id', 'account', 'line_id', 'stat_key', 'applies_to', 'mode', 'value', 'from_month', 'to_month', 'sort_order'],
      adjs.map((a: any) => [id, a.label, a.enabled, a.target_type, a.dept_id, a.account, a.line_id ? map.get(a.line_id) ?? null : null, a.stat_key, a.applies_to, a.mode, a.value, a.from_month, a.to_month, a.sort_order]));
    const cash = await qq('SELECT * FROM cash_items WHERE scenario_id=$1 AND ym LIKE $2', [srcId, `${src.fiscal_year}-%`]);
    await insertMany(qq, 'cash_items', ['scenario_id', 'ym', 'item_key', 'amount'], cash.map((c: any) => [id, reYm(c.ym), c.item_key, c.amount]));
    const notes = await qq('SELECT * FROM cash_notes WHERE scenario_id=$1', [srcId]);
    await insertMany(qq, 'cash_notes', ['scenario_id', 'item_key', 'note'], notes.map((n: any) => [id, n.item_key, n.note]));
    return id as number;
  });
}
