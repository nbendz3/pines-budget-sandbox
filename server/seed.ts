// npm run seed  - loads reference data and the starter budget from /seed. Safe to run twice.
// Real files go in /seed. Until they are there, the small made-up set in /seed/sample is used.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Papa from 'papaparse';
import { q, tx, insertMany, dbReady, type Q } from './db';
import { ymOf, type DriverType } from '../shared/calc';
import { parseMoney } from '../shared/gl';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SEED_DIR = path.join(here, '..', 'seed');

function findSeed(name: string): { file: string; sample: boolean } | null {
  const real = path.join(SEED_DIR, name);
  if (fs.existsSync(real)) return { file: real, sample: false };
  const sample = path.join(SEED_DIR, 'sample', name);
  if (fs.existsSync(sample)) return { file: sample, sample: true };
  return null;
}
export function readCsv(file: string): Record<string, string>[] {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter((l) => !l.trim().startsWith('#'));
  const out = Papa.parse<Record<string, string>>(lines.join('\n'), {
    header: true, skipEmptyLines: 'greedy', transformHeader: (h) => h.trim().toLowerCase(),
  });
  return out.data.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v ?? '').trim()])));
}
const yes = (v: string | undefined) => /^(y|yes|true|1)$/i.test(v ?? '');
const numOrNull = (v: string | undefined) => (v === undefined || v === '' ? null : parseMoney(v));

export function parseDriver(raw: string | null | undefined, kind: string): DriverType {
  const s = String(raw ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!s) return kind === 'REVENUE' ? 'TYPED' : 'FIXED';
  if (s === 'FIXED') return 'FIXED';
  if (s === 'TYPED') return 'TYPED';
  if (s === 'PCT_REVENUE' || s === '% OF REVENUE') return 'PCT_REVENUE';
  if (s === 'PCT_WAGES' || s === '% OF WAGES') return 'PCT_WAGES';
  if (s === 'PER_OCC_ROOM' || s === 'CPOR') return 'PER_OCC_ROOM';
  if (s === 'PER_COVER' || s === 'CPC') return 'PER_COVER';
  if (s === 'FTE' || s === 'FTE_HOURS') return 'FTE_HOURS';
  if (s === 'GROWTH_OVER_PY') return 'GROWTH_OVER_PY';
  if (s === 'ROOMS_X_ADR') return 'ROOMS_X_ADR';
  if (s === 'COVERS_X_CHECK') return 'COVERS_X_CHECK';
  return kind === 'REVENUE' ? 'TYPED' : 'FIXED';
}
/** Percent drivers are stored as fractions (0.009 = 0.9%). A value like 2.33 is read as 2.33%. */
export function normalizeRate(driver: DriverType, v: number | null): number | null {
  if (v === null) return null;
  if ((driver === 'PCT_REVENUE' || driver === 'PCT_WAGES') && Math.abs(v) > 1.5) return v / 100;
  return v;
}

export interface NewLine {
  entityId?: string; deptId: string; sheet: string; account: string; name: string; kind: string; category?: string;
  summaryRow?: string; driverType: DriverType; driverInput: number | null; isWageBase: boolean; isCustom?: boolean;
  typed?: (number | null)[]; override?: (number | null)[];
}
export async function insertLines(qq: Q, scenarioId: number, fiscalYear: number, lines: NewLine[]): Promise<number[]> {
  const ids = await insertMany(qq, 'budget_lines',
    ['scenario_id', 'entity_id', 'dept_id', 'budget_sheet', 'account', 'line_name', 'kind', 'budget_category', 'summary_row',
      'driver_type', 'driver_input', 'is_wage_base', 'is_custom', 'sort_order'],
    lines.map((l, i) => [scenarioId, l.entityId || 'E100', l.deptId, l.sheet, l.account, l.name, l.kind, l.category ?? null,
      l.summaryRow ?? null, l.driverType, l.driverInput, l.isWageBase, !!l.isCustom, i]),
    'RETURNING id');
  const months: any[][] = [];
  lines.forEach((l, i) => {
    for (let m = 0; m < 12; m++) months.push([ids[i].id, ymOf(fiscalYear, m), l.typed?.[m] ?? null, l.override?.[m] ?? null]);
  });
  await insertMany(qq, 'line_months', ['line_id', 'ym', 'typed', 'override'], months);
  return ids.map((r) => r.id);
}

/** Start a scenario's statistics from the same month last year (or two years back if last year is not in yet). */
export async function prefillStats(qq: Q, scenarioId: number, fiscalYear: number) {
  const ref = await qq(`SELECT dept_id, ym, key, value FROM stat_reference WHERE key IN ('rooms_sold','adr','ooo_room_nights','covers','avg_check')`);
  const rows: any[][] = [];
  const seen = new Set<string>();
  for (const back of [1, 2]) {
    for (const r of ref) {
      const [y, mm] = r.ym.split('-');
      if (Number(y) !== fiscalYear - back) continue;
      const k = `${r.dept_id}|${mm}|${r.key}`;
      if (seen.has(k) || r.value === null) continue;
      seen.add(k);
      rows.push([scenarioId, r.dept_id, `${fiscalYear}-${mm}`, r.key, r.key === 'ooo_room_nights' ? 0 : r.value]);
    }
  }
  if (rows.length) await insertMany(qq, 'stat_drivers', ['scenario_id', 'dept_id', 'ym', 'key', 'value'], rows, 'ON CONFLICT DO NOTHING');
}

export async function runSeed(log: (s: string) => void = console.log) {
  await dbReady();
  const report: string[] = [];
  const say = (s: string) => { report.push(s); log(s); };

  await tx(async (qq) => {
    // ---- entities
    const ent = findSeed('entities.csv');
    if (ent) {
      for (const r of readCsv(ent.file)) {
        if (!r.entity_id) continue;
        await qq(`INSERT INTO entities (entity_id, entity_name, note) VALUES ($1,$2,$3)
          ON CONFLICT (entity_id) DO UPDATE SET entity_name=EXCLUDED.entity_name, note=EXCLUDED.note`, [r.entity_id, r.entity_name || r.entity_id, r.note || null]);
      }
    }
    // ---- departments
    const dep = findSeed('departments.csv');
    if (dep) {
      const rows = readCsv(dep.file).filter((r) => r.dept_id);
      let i = 0;
      for (const r of rows) {
        await qq(`INSERT INTO departments (dept_id, dept_name, parent_group_id, bucket, is_rollup_group, source, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (dept_id) DO UPDATE SET dept_name=EXCLUDED.dept_name, parent_group_id=EXCLUDED.parent_group_id, bucket=EXCLUDED.bucket,
          is_rollup_group=EXCLUDED.is_rollup_group, source=EXCLUDED.source, sort_order=EXCLUDED.sort_order`,
          [r.dept_id, r.dept_name || r.dept_id, r.parent_group_id || null, r.usali_style_bucket || null, yes(r.is_rollup_group), r.source || null, i++]);
      }
      say(`departments: ${rows.length}${dep.sample ? ' (SAMPLE file)' : ''}`);
    }
    // ---- accounts
    const coa = findSeed('chart_of_accounts.csv');
    if (coa) {
      const rows = readCsv(coa.file).filter((r) => r.account);
      await insertMany(qq, 'accounts', ['account', 'name', 'type', 'pl_section', 'revenue_source_system'],
        rows.map((r) => [r.account, r.name || r.account, r.type || null,
          r.pl_report_section_in_sage_oct2026_export || r.pl_section || null, r.revenue_source_system || null]),
        `ON CONFLICT (account) DO UPDATE SET name=EXCLUDED.name, type=EXCLUDED.type, pl_section=EXCLUDED.pl_section, revenue_source_system=EXCLUDED.revenue_source_system`);
      say(`accounts: ${rows.length}${coa.sample ? ' (SAMPLE file)' : ''}`);
    }
    // ---- HMS history (read-only reference)
    const hms = findSeed('drivers_hms_monthly_2025_2026.csv');
    if (hms) {
      const ref: any[][] = [];
      for (const r of readCsv(hms.file)) {
        if (!/^\d{4}-\d{2}$/.test(r.month ?? '')) continue;
        const src = `HMS${hms.sample ? ' (sample file)' : ''} ${r.source_note ?? ''}`.trim();
        for (const [key, col] of [['rooms_sold', 'rooms_sold'], ['adr', 'adr'], ['ooo_room_nights', 'ooo_room_nights'],
          ['room_revenue_hms', 'room_revenue_hms'], ['occupancy_pct', 'occupancy_pct'], ['revpar', 'revpar']]) {
          const v = numOrNull(r[col]);
          if (v !== null) ref.push(['', r.month, key, v, src]);
        }
      }
      await insertMany(qq, 'stat_reference', ['dept_id', 'ym', 'key', 'value', 'source'], ref,
        'ON CONFLICT (dept_id, ym, key) DO UPDATE SET value=EXCLUDED.value, source=EXCLUDED.source');
      say(`HMS reference rows: ${ref.length}`);
    }
    // ---- Lightspeed covers (outlets that share a department are added together)
    const ls = findSeed('drivers_lightspeed_covers_2025_2026.csv');
    if (ls) {
      const agg = new Map<string, { sales: number; covers: number; checks: number }>();
      for (const r of readCsv(ls.file)) {
        if (!/^\d{4}-\d{2}$/.test(r.month ?? '') || !r.suggested_dept_id) continue;
        const k = `${r.suggested_dept_id}|${r.month}`;
        const a = agg.get(k) ?? { sales: 0, covers: 0, checks: 0 };
        a.sales += parseMoney(r.net_sales); a.covers += parseMoney(r.covers); a.checks += parseMoney(r.guest_checks);
        agg.set(k, a);
      }
      const ref: any[][] = [];
      const src = `Lightspeed${ls.sample ? ' (sample file)' : ''}`;
      for (const [k, a] of agg) {
        const [dept, ym] = k.split('|');
        ref.push([dept, ym, 'covers', a.covers, src], [dept, ym, 'net_sales', a.sales, src], [dept, ym, 'guest_checks', a.checks, src]);
        if (a.covers) ref.push([dept, ym, 'avg_check', a.sales / a.covers, src]);
      }
      await insertMany(qq, 'stat_reference', ['dept_id', 'ym', 'key', 'value', 'source'], ref,
        'ON CONFLICT (dept_id, ym, key) DO UPDATE SET value=EXCLUDED.value, source=EXCLUDED.source');
      say(`Lightspeed reference rows: ${ref.length}`);
    }
    // ---- settings and one-time items
    for (const [k, v] of [['room_count', '106'], ['fiscal_year', '2027'], ['default_entity', 'E100'], ['rooms_dept', '20'], ['room_rev_accounts', '4001,4002']]) {
      await qq(`INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING`, [k, v]);
    }
    const [{ n: normCount }] = await qq<{ n: number }>(`SELECT count(*)::int AS n FROM normalizations`);
    if (!normCount) {
      await insertMany(qq, 'normalizations', ['label', 'account', 'dept_id', 'ym', 'amount', 'enabled'], [
        ['Dec 2025 asset-sale gain (confirm the account)', '', null, '2025-12', 351489, false],
        ['Dec 2025 Market inventory adjustment (about -$188K, confirm)', '5119', '70', '2025-12', -188000, false],
        ['Jan 2026 lodging entry (about $178K, confirm)', '4020', null, '2026-01', 178000, false],
        ['Feb 2026 bad-debt recovery (about -$71.7K, confirm)', '6350', null, '2026-02', -71700, false],
      ]);
    }
    // ---- starter budget
    const tpl = findSeed('budget_lines_template.csv');
    if (tpl) {
      const fy = 2027;
      const name = tpl.sample ? 'SAMPLE 2027 Budget (made-up numbers)' : '2027 Budget - Starter';
      const [{ n: total }] = await qq<{ n: number }>(`SELECT count(*)::int AS n FROM scenarios WHERE NOT is_sample`);
      const existing = await qq(`SELECT id FROM scenarios WHERE name=$1`, [name]);
      if (tpl.sample && (total > 0 || existing.length)) {
        say('starter budget: left as it is');
      } else if (!tpl.sample && existing.length) {
        say(`starter budget "${name}" already loaded, left as it is`);
      } else {
        if (!tpl.sample) await qq(`DELETE FROM scenarios WHERE is_sample AND name LIKE 'SAMPLE %'`);
        const rows = readCsv(tpl.file).filter((r) => r.account && r.dept_id);
        const [{ id }] = await qq(`INSERT INTO scenarios (name, kind, fiscal_year, status, is_sample) VALUES ($1,'BUDGET',$2,'DRAFT',$3) RETURNING id`, [name, fy, tpl.sample]);
        const lines: NewLine[] = rows.map((r) => {
          const kind = (r.kind || (r.account.startsWith('4') ? 'REVENUE' : 'COST')).toUpperCase();
          const driverType = parseDriver(r.driver_2026_budget, kind);
          const typed = Array.from({ length: 12 }, (_, m) => numOrNull(r[`m${String(m + 1).padStart(2, '0')}`]));
          return {
            entityId: r.entity_id || 'E100', deptId: r.dept_id, sheet: r.budget_sheet || r.dept_id, account: r.account,
            name: r.line_name || r.account, kind, category: r.budget_category, summaryRow: r.summary_row,
            driverType, driverInput: normalizeRate(driverType, numOrNull(r.driver_input_2026_budget)), isWageBase: yes(r.is_wage_base), typed,
          };
        });
        await insertLines(qq, id, fy, lines);
        await prefillStats(qq, id, fy);
        const sheets = new Set(lines.map((l) => l.sheet)).size;
        say(`starter budget "${name}": ${lines.length} lines on ${sheets} tabs (${lines.filter((l) => l.kind === 'REVENUE').length} revenue, ${lines.filter((l) => l.kind === 'COST').length} cost)`);
      }
    }
  });

  // ---- checks from the build kit (only meaningful with the real files)
  const [c] = await q(`SELECT (SELECT count(*)::int FROM accounts) AS accounts, (SELECT count(*)::int FROM departments) AS departments,
    (SELECT count(*)::int FROM budget_lines b WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.account=b.account)) AS bad_accounts,
    (SELECT count(*)::int FROM budget_lines b WHERE NOT EXISTS (SELECT 1 FROM departments d WHERE d.dept_id=b.dept_id)) AS bad_depts`);
  say(`check: ${c.accounts} accounts (kit expects 277), ${c.departments} departments (41), ${c.bad_accounts} budget lines with an unknown account, ${c.bad_depts} with an unknown department`);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSeed().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
