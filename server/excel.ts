// Excel export with live formulas, laid out like the budget workbook:
// A code, B account, C budget item, D category, E driver, F driver input, G..R Jan..Dec, S total.
import ExcelJS from 'exceljs';
import {
  MONTHS, SUMMARY_LAYOUT, CASH_ROWS, normalizeBucket, sum, zeros, roomsAvailable, occupancyPct, revPar,
  type Line, type Num12, type DriverType,
} from '../shared/calc';
import { computeBundle, type Bundle } from './scenario';

const DRIVER_XL: Record<DriverType, string> = {
  TYPED: '', FIXED: 'Fixed', PCT_REVENUE: '% of Revenue', PCT_WAGES: '% Of Wages', PER_OCC_ROOM: 'CPOR', PER_COVER: 'CPC',
  GROWTH_OVER_PY: 'GROWTH_OVER_PY', FTE_HOURS: 'FTE', ROOMS_X_ADR: 'ROOMS_X_ADR', COVERS_X_CHECK: 'COVERS_X_CHECK',
};
const MONEY = '#,##0;(#,##0);-';
const col = (m: number) => String.fromCharCode('G'.charCodeAt(0) + m); // G..R
const safeName = (s: string, used: Set<string>) => {
  let n = s.replace(/[\\/*?:[\]]/g, ' ').slice(0, 31).trim() || 'Sheet';
  while (used.has(n.toLowerCase())) n = `${n.slice(0, 28)} 2`;
  used.add(n.toLowerCase());
  return n;
};
const ref = (sheet: string) => `'${sheet.replace(/'/g, "''")}'`;

export async function buildWorkbook(b: Bundle): Promise<ExcelJS.Workbook> {
  const { result, summary, cash } = computeBundle(b);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Pines Budget Sandbox';
  wb.calcProperties.fullCalcOnLoad = true;
  const used = new Set<string>(['summary p&l', 'drivers', 'levers', 'cash flow']);
  const sum1 = wb.addWorksheet('Summary P&L', { views: [{ state: 'frozen', xSplit: 1, ySplit: 2 }] });

  const sheets: string[] = [];
  for (const l of b.lines) if (!sheets.includes(l.sheet)) sheets.push(l.sheet);
  const deptSheets = new Map<string, Set<string>>();
  for (const l of b.lines) (deptSheets.get(l.deptId) ?? deptSheets.set(l.deptId, new Set()).get(l.deptId)!).add(l.sheet);

  // bucket|kind -> [{sheet, first, last}]
  const where = new Map<string, { sheet: string; first: number; last: number }[]>();

  for (const tab of sheets) {
    const name = safeName(tab, used);
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', xSplit: 3, ySplit: 2 }] });
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:2' };
    const lines = b.lines.filter((l) => l.sheet === tab);
    const deptId = lines[0].deptId;
    const single = lines.every((l) => l.deptId === deptId) && deptSheets.get(deptId)!.size === 1;
    const d = result.depts[deptId];
    ws.getCell('A1').value = `${tab} - ${b.scenario.name} (FY ${b.scenario.fiscal_year})`;
    ws.getCell('A1').font = { bold: true, size: 12 };
    ws.getRow(2).values = ['Code', 'Account', 'Budget Item', 'Category', 'Driver', 'Driver Input', ...MONTHS, 'Total', 'Comments', 'Summary row', 'Kind'];
    ws.getRow(2).font = { bold: true };
    ws.columns.forEach((c, i) => { c.width = i === 2 ? 34 : i === 3 ? 20 : i >= 6 && i <= 18 ? 13 : i === 0 ? 12 : 11; });
    let r = 3;
    const statRow = (label: string, vals: Num12) => {
      ws.getRow(r).values = [null, null, label, null, null, null, ...vals, sum(vals)];
      ws.getRow(r).font = { italic: true };
      for (let c = 7; c <= 19; c++) ws.getRow(r).getCell(c).numFmt = '#,##0.0';
      return r++;
    };
    const needsOcc = lines.some((l) => l.driverType === 'PER_OCC_ROOM');
    const needsCov = lines.some((l) => l.driverType === 'PER_COVER');
    const occVals = deptId === b.options.roomsDept ? result.stats.roomsSold : result.stats.occRooms[deptId] ?? zeros();
    const occRow = needsOcc ? statRow('Occuped Rooms', occVals) : 0;
    const covRow = needsCov ? statRow('Covers Served', result.stats.covers[deptId] ?? zeros()) : 0;

    const rev = lines.filter((l) => l.kind === 'REVENUE');
    const cost = lines.filter((l) => l.kind === 'COST').sort((a, c) => Number(!!c.isPayroll) - Number(!!a.isPayroll));
    const firstRev = r;
    const lastRev = r + rev.length - 1;
    const totalRevRow = rev.length ? lastRev + 1 : 0;
    const firstCost = (rev.length ? lastRev + 2 : r);
    const rowOf = new Map<number, number>();
    rev.forEach((l, i) => rowOf.set(l.id, firstRev + i));
    cost.forEach((l, i) => rowOf.set(l.id, firstCost + i));
    const wageRows = cost.filter((l) => l.isWageBase && l.driverType !== 'PCT_WAGES').map((l) => rowOf.get(l.id)!);

    const writeLine = (l: Line) => {
      const rr = rowOf.get(l.id)!;
      const vals = result.byLine[l.id] ?? zeros();
      const row = ws.getRow(rr);
      row.getCell(1).value = `${l.deptId}-${l.account}-1`;
      row.getCell(2).value = l.account;
      row.getCell(3).value = l.name;
      row.getCell(4).value = l.category ?? '';
      row.getCell(5).value = DRIVER_XL[l.driverType];
      if (l.driverInput !== null && l.driverInput !== undefined) row.getCell(6).value = l.driverInput;
      for (let m = 0; m < 12; m++) {
        const c = row.getCell(7 + m);
        const v = vals[m];
        let f: string | null = null;
        let expect = 0;
        const overridden = l.override[m] !== null && l.override[m] !== undefined;
        if (!overridden && single && l.driverInput !== null) {
          if (l.driverType === 'PER_OCC_ROOM' && occRow) { f = `$F${rr}*${col(m)}${occRow}`; expect = l.driverInput * (occVals[m] || 0); }
          else if (l.driverType === 'PER_COVER' && covRow) { f = `$F${rr}*${col(m)}${covRow}`; expect = l.driverInput * ((result.stats.covers[deptId] ?? zeros())[m] || 0); }
          else if (l.driverType === 'PCT_REVENUE' && l.kind === 'COST' && totalRevRow) { f = `$F${rr}*${col(m)}${totalRevRow}`; expect = l.driverInput * d.revenue[m]; }
          else if (l.driverType === 'PCT_WAGES' && wageRows.length) { f = `$F${rr}*(${wageRows.map((w) => `${col(m)}${w}`).join('+')})`; expect = l.driverInput * d.wages[m]; }
        }
        if (f) {
          const delta = v - expect; // what a lever added on top of the driver
          if (Math.abs(delta) >= 0.005) f = `${f}+(${Number(delta.toFixed(4))})`;
          c.value = { formula: f, result: v };
        } else c.value = v;
        c.numFmt = MONEY;
        if (overridden) c.font = { color: { argb: 'FF9A3412' } };
      }
      row.getCell(19).value = { formula: `SUM(G${rr}:R${rr})`, result: sum(vals) };
      row.getCell(19).numFmt = MONEY;
      row.getCell(21).value = normalizeBucket(l.summaryRow, l.deptId, l.sheet);
      row.getCell(22).value = l.kind;
    };
    const totalRow = (rr: number, label: string, f: (m: number) => string, vals: Num12) => {
      const row = ws.getRow(rr);
      row.getCell(3).value = label;
      row.font = { bold: true };
      for (let m = 0; m < 12; m++) { row.getCell(7 + m).value = { formula: f(m), result: vals[m] }; row.getCell(7 + m).numFmt = MONEY; }
      row.getCell(19).value = { formula: `SUM(G${rr}:R${rr})`, result: sum(vals) };
      row.getCell(19).numFmt = MONEY;
      row.getCell(7).border = { top: { style: 'thin' } };
    };
    rev.forEach(writeLine);
    const revVals = rev.reduce((t, l) => t.map((v, m) => v + (result.byLine[l.id]?.[m] ?? 0)), zeros());
    const costVals = cost.reduce((t, l) => t.map((v, m) => v + (result.byLine[l.id]?.[m] ?? 0)), zeros());
    if (rev.length) totalRow(totalRevRow, 'Total Revenue', (m) => `SUM(${col(m)}${firstRev}:${col(m)}${lastRev})`, revVals);
    cost.forEach(writeLine);
    const lastCost = firstCost + cost.length - 1;
    let totalExpRow = 0;
    if (cost.length) {
      totalExpRow = lastCost + 1;
      totalRow(totalExpRow, 'Total Expenses', (m) => `SUM(${col(m)}${firstCost}:${col(m)}${lastCost})`, costVals);
    }
    const profitRow = Math.max(totalExpRow, totalRevRow, r) + 1;
    totalRow(profitRow, 'Departmental Profit', (m) => `${totalRevRow ? `${col(m)}${totalRevRow}` : '0'}-${totalExpRow ? `${col(m)}${totalExpRow}` : '0'}`,
      revVals.map((v, m) => v - costVals[m]));
    ws.getColumn(21).hidden = true; ws.getColumn(22).hidden = true;

    const note = (ls: Line[], first: number) => {
      const seen = new Set<string>();
      for (const l of ls) {
        const key = `${normalizeBucket(l.summaryRow, l.deptId, l.sheet)}|${l.kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        (where.get(key) ?? where.set(key, []).get(key)!).push({ sheet: name, first, last: first + ls.length - 1 });
      }
    };
    if (rev.length) note(rev, firstRev);
    if (cost.length) note(cost, firstCost);
  }

  // ---- Summary P&L, referencing the department sheets
  sum1.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 };
  sum1.getCell('A1').value = `Summary P&L - ${b.scenario.name} (FY ${b.scenario.fiscal_year})`;
  sum1.getCell('A1').font = { bold: true, size: 12 };
  sum1.getRow(2).values = ['', ...MONTHS, 'Total'];
  sum1.getRow(2).font = { bold: true };
  sum1.getColumn(1).width = 44;
  for (let c = 2; c <= 14; c++) sum1.getColumn(c).width = 13;
  const sc = (m: number) => String.fromCharCode('B'.charCodeAt(0) + m); // B..M, N = total
  const srow = new Map<string, number>();
  SUMMARY_LAYOUT.forEach((d, i) => srow.set(d.key, 3 + i));
  const sumifs = (bucket: string, kind: string, m: number) =>
    (where.get(`${bucket}|${kind}`) ?? []).map((w) =>
      `SUMIFS(${ref(w.sheet)}!${col(m)}$${w.first}:${col(m)}$${w.last},${ref(w.sheet)}!$U$${w.first}:$U$${w.last},"${bucket}",${ref(w.sheet)}!$V$${w.first}:$V$${w.last},"${kind}")`).join('+') || '0';
  const cell = (k: string, m: number) => `${sc(m)}${srow.get(k)}`;
  const net = (bk: string, m: number) => `(${sumifs(bk, 'COST', m)})-(${sumifs(bk, 'REVENUE', m)})`;
  const F: Record<string, (m: number) => string> = {
    rev_ROOMS: (m) => sumifs('ROOMS', 'REVENUE', m), rev_FB: (m) => sumifs('FB', 'REVENUE', m),
    rev_OTHER: (m) => sumifs('OTHER_OPERATED', 'REVENUE', m), rev_MISC: (m) => sumifs('MISC_INCOME', 'REVENUE', m),
    total_rev: (m) => ['rev_ROOMS', 'rev_FB', 'rev_OTHER', 'rev_MISC'].map((k) => cell(k, m)).join('+'),
    exp_ROOMS: (m) => sumifs('ROOMS', 'COST', m), exp_FB: (m) => sumifs('FB', 'COST', m),
    exp_OTHER: (m) => `(${sumifs('OTHER_OPERATED', 'COST', m)})+(${sumifs('MISC_INCOME', 'COST', m)})`,
    total_dept_exp: (m) => ['exp_ROOMS', 'exp_FB', 'exp_OTHER'].map((k) => cell(k, m)).join('+'),
    dept_profit: (m) => `${cell('total_rev', m)}-${cell('total_dept_exp', m)}`,
    AG: (m) => net('AG', m), IT: (m) => net('IT', m), RM: (m) => net('RM', m), SM: (m) => net('SM', m),
    UTILITIES: (m) => net('UTILITIES', m), NO_DEPT: (m) => net('NO_DEPT', m),
    total_undist: (m) => ['AG', 'IT', 'RM', 'SM', 'UTILITIES', 'NO_DEPT'].map((k) => cell(k, m)).join('+'),
    gop: (m) => `${cell('dept_profit', m)}-${cell('total_undist', m)}`,
    nonop_income: (m) => `(${sumifs('NONOP_INCOME', 'REVENUE', m)})-(${sumifs('NONOP_INCOME', 'COST', m)})`,
    insurance: (m) => net('INSURANCE', m), prop_tax: (m) => net('PROPERTY_TAXES', m),
    total_nonop: (m) => `${cell('nonop_income', m)}-${cell('insurance', m)}-${cell('prop_tax', m)}`,
    ebitda: (m) => `${cell('gop', m)}+${cell('total_nonop', m)}`,
    amort: (m) => net('AMORTIZATION', m), deprec: (m) => net('DEPRECIATION', m), interest: (m) => net('INTEREST', m),
    net_income: (m) => `${cell('ebitda', m)}-${cell('amort', m)}-${cell('deprec', m)}-${cell('interest', m)}`,
    owner: (m) => net('OWNER', m),
    ni_less_owner: (m) => `${cell('net_income', m)}-${cell('owner', m)}`,
  };
  for (const d of SUMMARY_LAYOUT) {
    const rr = srow.get(d.key)!;
    const row = sum1.getRow(rr);
    row.getCell(1).value = d.label;
    if (d.style === 'head') { row.font = { bold: true, color: { argb: 'FF475569' } }; continue; }
    if (d.style === 'total') row.font = { bold: true };
    if (d.style === 'pct') row.font = { italic: true };
    for (let m = 0; m <= 12; m++) {
      const c = row.getCell(2 + m);
      const letter = m === 12 ? 'N' : sc(m);
      if (d.style === 'pct') {
        const rv = m === 12 ? sum(summary.total_rev) : summary.total_rev[m];
        const nv = m === 12 ? sum(summary[d.of!]) : summary[d.of!][m];
        c.value = { formula: `IF(${letter}${srow.get('total_rev')}=0,0,${letter}${srow.get(d.of!)}/${letter}${srow.get('total_rev')})`, result: rv ? nv / rv : 0 };
        c.numFmt = '0.0%';
      } else {
        c.value = m === 12 ? { formula: `SUM(B${rr}:M${rr})`, result: sum(summary[d.key]) } : { formula: F[d.key](m), result: summary[d.key][m] };
        c.numFmt = MONEY;
      }
    }
  }

  // ---- Drivers
  const dr = wb.addWorksheet('Drivers', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });
  dr.getRow(1).values = ['Driver', ...MONTHS, 'Total / average'];
  dr.getRow(1).font = { bold: true };
  dr.getColumn(1).width = 38;
  const s = result.stats;
  const drow = (label: string, vals: Num12, total: number | null, fmt = '#,##0.0') => {
    const row = dr.addRow([label, ...vals, total]);
    for (let c = 2; c <= 14; c++) row.getCell(c).numFmt = fmt;
  };
  drow('Rooms available', roomsAvailable(s), sum(roomsAvailable(s)));
  drow('Rooms sold (occupied rooms)', s.roomsSold, sum(s.roomsSold));
  const capacity = sum(s.days) * s.roomCount;
  drow('Occupancy %', occupancyPct(s), capacity ? (100 * sum(s.roomsSold)) / capacity : 0, '0.0');
  const roomRev = s.roomsSold.map((v, m) => v * s.adr[m]);
  drow('ADR', s.adr, sum(s.roomsSold) ? sum(roomRev) / sum(s.roomsSold) : 0, '#,##0.00');
  drow('RevPAR', revPar(s), capacity ? sum(roomRev) / capacity : 0, '#,##0.00');
  for (const [dept, v] of Object.entries(s.occRooms)) drow(`Occupied rooms - dept ${dept}`, v, sum(v));
  for (const [dept, v] of Object.entries(s.covers)) {
    drow(`Covers - dept ${dept}`, v, sum(v));
    const ch = s.avgCheck[dept] ?? zeros();
    drow(`Average check - dept ${dept}`, ch, null, '#,##0.00');
  }

  // ---- Levers (values only)
  const lv = wb.addWorksheet('Levers');
  lv.getRow(1).values = ['Lever', 'On', 'Target', 'Department', 'Account', 'Applies to', 'Type', 'Value', 'From', 'To'];
  lv.getRow(1).font = { bold: true };
  lv.getColumn(1).width = 40;
  for (const a of b.adjustments) {
    lv.addRow([a.label, a.enabled ? 'ON' : 'off', a.targetType === 'STAT' ? `Statistic: ${a.statKey}` : a.targetType, a.deptId ?? '', a.account ?? '',
      a.appliesTo, a.mode, a.value, MONTHS[a.fromMonth], MONTHS[a.toMonth]]);
  }
  if (!b.adjustments.length) lv.addRow(['(no levers on this scenario)']);

  // ---- Cash flow
  const cf = wb.addWorksheet('Cash Flow', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });
  cf.getRow(1).values = ['Cash flow', ...MONTHS, 'Total', 'Note'];
  cf.getRow(1).font = { bold: true };
  cf.getColumn(1).width = 44;
  for (const rdef of CASH_ROWS) {
    const vals = cash.rows[rdef.key];
    const total = rdef.key === 'opening' ? vals[0] : rdef.key === 'ending' ? vals[11] : sum(vals);
    const row = cf.addRow([rdef.label, ...vals, total, b.cashNotes[rdef.key] ?? '']);
    if (rdef.section === 'total' || rdef.section === 'open') row.font = { bold: true };
    for (let c = 2; c <= 14; c++) { row.getCell(c).numFmt = MONEY; cf.getColumn(c).width = 13; }
  }
  return wb;
}

export function buildCsv(b: Bundle): string {
  const { result } = computeBundle(b);
  const esc = (v: any) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const out = ['scenario,dept_id,account,line_name,ym,amount'];
  for (const l of b.lines) {
    for (let m = 0; m < 12; m++) {
      out.push([b.scenario.name, l.deptId, l.account, l.name, `${b.scenario.fiscal_year}-${String(m + 1).padStart(2, '0')}`, (result.byLine[l.id]?.[m] ?? 0).toFixed(2)].map(esc).join(','));
    }
  }
  return out.join('\n') + '\n';
}
