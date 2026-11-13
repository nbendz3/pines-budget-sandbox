// Import the existing budget workbook (2026_Budget_from_Nick.xlsx / 2027_Budget_DRAFT_v3.xlsx).
// Reads CACHED values, never formulas. The department comes from the TAB NAME, not the code prefix.
import ExcelJS from 'exceljs';
import { tx, insertMany } from './db';
import { insertLines, parseDriver, normalizeRate, type NewLine } from './seed';
import { loadBundle, computeBundle } from './scenario';
import { DEPT_BUCKET, DERIVED_DRIVERS, ymOf, sum } from '../shared/calc';

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const TAB_DEPT: Record<string, string> = Object.fromEntries(Object.entries({
  'Rooms': '20', 'Granite Ridge': '71', 'Victoria Pl': '72', 'Wintergreen': '73', 'Atascadero': '74', 'Condo 75': '75',
  'Duceys': '10', 'Banquets - Cabana': '12', 'Banquets - Lake View': '13', 'Pines Bar': '15', 'Glice': '17', 'Gas Station': '65',
  'Market': '70', 'Miscellaneous Income': '25', 'Administrative and General': '30', 'Information and Technologies': '31',
  'Utilities': '35', 'Repair and Maintenance': '40', 'Sales and Marketing': '50', 'Lake House': '90', 'Bass Drive': '91',
  'Franklin House': '92', 'Interest Expenses': '94', 'Insurance': '95', 'Property&Other Taxes': '95', 'Owners Expenses': '99',
  'Depreciation': '96', 'Amortization': '97',
}).map(([k, v]) => [norm(k), v]));
const SKIP = ['Data Validation', 'Cash Flow Projections', 'Data', 'Summary P&L', 'Sage BS', 'Assumptions', 'Assumptions & Method',
  'Base Year', 'Budget vs Actual', 'Open Questions', 'MinWage', 'Drivers', 'Levers', 'Cash Flow'].map(norm);

function text(cell: ExcelJS.Cell): string {
  const v: any = cell.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t: any) => t.text).join('').trim();
    if ('result' in v) return v.result === null || v.result === undefined || typeof v.result === 'object' ? '' : String(v.result).trim();
    if (v instanceof Date) return v.toISOString();
    if ('text' in v) return String(v.text).trim();
    return '';
  }
  return String(v).trim();
}
/** Cached number in a cell. `stale` = the cell has a formula but no saved result. */
function num(cell: ExcelJS.Cell): { v: number | null; stale: boolean } {
  const v: any = cell.value;
  if (v === null || v === undefined || v === '') return { v: null, stale: false };
  if (typeof v === 'number') return { v, stale: false };
  if (typeof v === 'object' && ('formula' in v || 'sharedFormula' in v)) {
    return typeof v.result === 'number' ? { v: v.result, stale: false } : { v: null, stale: v.result === undefined || v.result === null };
  }
  if (typeof v === 'string' && v.trim() && !Number.isNaN(Number(v.replace(/[$,%]/g, '')))) return { v: Number(v.replace(/[$,%]/g, '')), stale: false };
  return { v: null, stale: false };
}

export async function importWorkbook(buf: Buffer, fileName: string, opts: { name?: string; fiscalYear?: number; who: string }) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const fy = opts.fiscalYear || Number(fileName.match(/20\d\d/)?.[0]) || new Date().getFullYear() + 1;
  const lines: (NewLine & { cached: (number | null)[] })[] = [];
  const stats: { deptId: string; key: string; vals: (number | null)[] }[] = [];
  const skippedTabs: string[] = [];
  const unknownTabs: string[] = [];
  let staleCells = 0;

  for (const ws of wb.worksheets) {
    const tab = ws.name.trim();
    if (SKIP.includes(norm(tab)) || tab.endsWith('>>>')) { skippedTabs.push(tab); continue; }
    const deptId = TAB_DEPT[norm(tab)];
    if (!deptId) { unknownTabs.push(tab); continue; }
    const months = (row: ExcelJS.Row) => Array.from({ length: 12 }, (_, m) => {
      const n = num(row.getCell(7 + m));
      if (n.stale) staleCells++;
      return n.v;
    });
    ws.eachRow((row) => {
      const a = text(row.getCell(1));
      if (/^\d+-\d+-\d+$/.test(a)) {
        const account = a.split('-')[1];
        const kind = account.startsWith('4') ? 'REVENUE' : 'COST';
        const driverType = parseDriver(text(row.getCell(5)), kind);
        const cached = months(row);
        const bucket = norm(tab) === 'insurance' ? 'INSURANCE' : norm(tab) === 'propertyothertaxes' ? 'PROPERTY_TAXES' : DEPT_BUCKET[deptId] ?? '';
        lines.push({
          deptId, sheet: tab, account, name: text(row.getCell(3)) || a, kind, category: text(row.getCell(4)), summaryRow: bucket,
          driverType, driverInput: normalizeRate(driverType, num(row.getCell(6)).v), isWageBase: account === '6003', typed: cached, cached,
        });
        return;
      }
      const label = norm([1, 2, 3, 4, 5].map((c) => text(row.getCell(c))).join(' '));
      if (label.includes('occupedrooms') || label.includes('occupiedrooms')) {
        stats.push({ deptId: deptId === '20' ? '' : deptId, key: deptId === '20' ? 'rooms_sold' : 'occ_rooms', vals: months(row) });
      } else if (label.includes('coversserved')) stats.push({ deptId, key: 'covers', vals: months(row) });
    });
  }
  if (!lines.length) {
    throw Object.assign(new Error('No budget lines found. Expected department tabs with codes like 20-4001-1 in column A.'), { status: 400 });
  }

  // tie-out targets from the file's own Summary P&L tab
  const target: Record<string, (number | null)[]> = {};
  const sumWs = wb.worksheets.find((w) => norm(w.name) === norm('Summary P&L'));
  sumWs?.eachRow((row) => {
    const label = norm([1, 2, 3, 4].map((c) => text(row.getCell(c))).find((t) => t && Number.isNaN(Number(t.replace(/[$,()%\s-]/g, '') || 'x'))) ?? '');
    const key = label === 'totaloperatingrevenue' ? 'total_rev' : label === 'netincome' ? 'net_income' : label === 'ebitda' ? 'ebitda' : null;
    if (!key || target[key]) return;
    const nums: number[] = [];
    row.eachCell({ includeEmpty: false }, (cell) => { const n = num(cell).v; if (n !== null) nums.push(n); });
    if (nums.length >= 12) target[key] = nums.slice(0, 12);
  });

  const scenarioId = await tx(async (qq) => {
    const known = new Set((await qq<{ account: string }>('SELECT account FROM accounts')).map((r) => r.account));
    const name = opts.name || `${fileName.replace(/\.xlsx$/i, '')} (imported ${new Date().toISOString().slice(0, 10)})`;
    const [{ id }] = await qq(`INSERT INTO scenarios (name, kind, fiscal_year, status, notes) VALUES ($1,'BUDGET',$2,'DRAFT',$3) RETURNING id`,
      [name, fy, `Imported from ${fileName} by ${opts.who}`]);
    await insertLines(qq, id, fy, lines);
    const srows: any[][] = [];
    for (const s of stats) s.vals.forEach((v, m) => { if (v !== null) srows.push([id, s.deptId, ymOf(fy, m), s.key, v]); });
    await insertMany(qq, 'stat_drivers', ['scenario_id', 'dept_id', 'ym', 'key', 'value'], srows, 'ON CONFLICT DO NOTHING');
    (lines as any).unknown = lines.filter((l) => !known.has(l.account)).map((l) => `${l.sheet}: ${l.account} ${l.name}`);
    return id as number;
  });

  // Where the engine and the workbook disagree, keep the workbook's number as an override and say so.
  let b = await loadBundle(scenarioId);
  let c = computeBundle(b);
  const mismatches: string[] = [];
  const overrides: any[][] = [];
  b.lines.forEach((l, i) => {
    if (!DERIVED_DRIVERS.includes(l.driverType)) return;
    const cached = lines[i].cached;
    let hit = false;
    for (let m = 0; m < 12; m++) {
      if (cached[m] === null) continue;
      if (Math.abs((c.result.byLine[l.id]?.[m] ?? 0) - cached[m]!) > 0.5) { overrides.push([cached[m], l.id, ymOf(fy, m)]); hit = true; }
    }
    if (hit) mismatches.push(`${l.sheet}: ${l.account} ${l.name}`);
  });
  if (overrides.length) {
    await tx(async (qq) => { for (const o of overrides) await qq('UPDATE line_months SET override=$1 WHERE line_id=$2 AND ym=$3', o); });
    b = await loadBundle(scenarioId);
    c = computeBundle(b);
  }
  const tie = (['total_rev', 'net_income', 'ebitda'] as const).filter((k) => target[k]).map((k) => {
    const diffs = c.summary[k].map((v, m) => Math.round((v - (target[k][m] ?? 0)) * 100) / 100);
    return { row: k, app: c.summary[k], file: target[k], diffs, appTotal: sum(c.summary[k]), fileTotal: sum(target[k]), ok: diffs.every((d) => Math.abs(d) <= 1) };
  });
  return {
    scenarioId, fiscalYear: fy, lineCount: lines.length, tabs: [...new Set(lines.map((l) => l.sheet))].length, skippedTabs, unknownTabs,
    unknownAccounts: (lines as any).unknown as string[], staleCells, mismatches, overrideCells: overrides.length, tie,
    summaryFound: !!sumWs,
  };
}
