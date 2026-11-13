// End-to-end checks against an in-memory database: seed, compute, export, re-import.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';

process.env.USE_PGLITE = '1';
process.env.PGLITE_DIR = 'memory';

const realSeed = fs.existsSync(path.join(__dirname, '..', 'seed', 'budget_lines_template.csv'));
let db: typeof import('../server/db');
let scen: typeof import('../server/scenario');
let sid: number;

beforeAll(async () => {
  db = await import('../server/db');
  scen = await import('../server/scenario');
  const { runSeed } = await import('../server/seed');
  await runSeed(() => {});
  await runSeed(() => {}); // safe to run twice
  sid = (await db.q('SELECT id FROM scenarios ORDER BY id LIMIT 1'))[0].id;
});

describe('seed', () => {
  it('running it twice does not duplicate anything', async () => {
    const [{ n }] = await db.q('SELECT count(*)::int AS n FROM scenarios');
    expect(n).toBe(1);
  });
  it('every budget line has a known account and department, and 12 months', async () => {
    const [r] = await db.q(`SELECT
      (SELECT count(*)::int FROM budget_lines b WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.account=b.account)) AS bad_a,
      (SELECT count(*)::int FROM budget_lines b WHERE NOT EXISTS (SELECT 1 FROM departments d WHERE d.dept_id=b.dept_id)) AS bad_d,
      (SELECT count(*)::int FROM budget_lines) AS lines, (SELECT count(*)::int FROM line_months) AS months`);
    expect(r.bad_a).toBe(0);
    expect(r.bad_d).toBe(0);
    expect(r.months).toBe(r.lines * 12);
  });
  // These are the build kit's numbers. They only apply once the real CSVs are in /seed.
  it.skipIf(!realSeed)('real seed files: 424 lines, 28 tabs, 88 revenue, 336 cost, 277 accounts, 41 departments', async () => {
    const [r] = await db.q(`SELECT (SELECT count(*)::int FROM budget_lines) AS lines, (SELECT count(DISTINCT budget_sheet)::int FROM budget_lines) AS tabs,
      (SELECT count(*)::int FROM budget_lines WHERE kind='REVENUE') AS rev, (SELECT count(*)::int FROM budget_lines WHERE kind='COST') AS cost,
      (SELECT count(*)::int FROM accounts) AS accounts, (SELECT count(*)::int FROM departments) AS depts`);
    expect(r).toEqual({ lines: 424, tabs: 28, rev: 88, cost: 336, accounts: 277, depts: 41 });
  });
  it('July 2025 ADR is 342.47 in the HMS history', async () => {
    const [r] = await db.q(`SELECT value FROM stat_reference WHERE dept_id='' AND ym='2025-07' AND key='adr'`);
    expect(r.value).toBe(342.47);
  });
});

describe('scenario copy, lock and export', () => {
  it('a copy computes to exactly the same numbers', async () => {
    const id = await scen.copyScenario(sid, 'copy');
    const a = scen.computeBundle(await scen.loadBundle(sid));
    const b = scen.computeBundle(await scen.loadBundle(id));
    expect(b.summary.net_income).toEqual(a.summary.net_income);
    expect(b.summary.total_rev).toEqual(a.summary.total_rev);
  });
  it('a locked scenario refuses changes', async () => {
    const id = await scen.copyScenario(sid, 'locked copy');
    await db.q(`UPDATE scenarios SET status='LOCKED' WHERE id=$1`, [id]);
    await expect(scen.assertUnlocked(id)).rejects.toThrow(/locked/);
  });
  it('the exported Summary P&L equals the app, and re-importing the export ties out', async () => {
    const { buildWorkbook, buildCsv } = await import('../server/excel');
    const { importWorkbook } = await import('../server/workbook');
    const bundle = await scen.loadBundle(sid);
    const { summary } = scen.computeBundle(bundle);
    const buf = Buffer.from(await (await buildWorkbook(bundle)).xlsx.writeBuffer());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as any);
    const ws = wb.getWorksheet('Summary P&L')!;
    const yearOf = (label: string) => {
      let v: number | null = null;
      ws.eachRow((row) => { if (row.getCell(1).value === label) v = (row.getCell(14).value as any).result; });
      return v!;
    };
    const total = (a: number[]) => a.reduce((t, x) => t + x, 0);
    expect(yearOf('Total Operating Revenue')).toBeCloseTo(total(summary.total_rev), 2);
    expect(yearOf('Net Income')).toBeCloseTo(total(summary.net_income), 2);
    expect(buildCsv(bundle).split('\n').length).toBe(bundle.lines.length * 12 + 2);

    const back = await importWorkbook(buf, 'roundtrip_2027.xlsx', { who: 'test' });
    expect(back.lineCount).toBe(bundle.lines.length);
    expect(back.tie.length).toBeGreaterThanOrEqual(2);
    expect(back.tie.every((t) => t.ok)).toBe(true);
  });
});
