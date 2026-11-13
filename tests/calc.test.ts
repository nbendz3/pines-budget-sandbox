import { describe, it, expect } from 'vitest';
import {
  computeDept, computeScenario, summarizeScenario, emptyStats, occupancyPct, computeCash, spreadByShape,
  sensitivity, normalizeBucket, nulls, zeros, sum, round2, type Line, type Adjustment,
} from '../shared/calc';

let id = 0;
const line = (p: Partial<Line>): Line => ({
  id: ++id, deptId: '20', sheet: 'Rooms', account: '6999', name: 'x', kind: 'COST', summaryRow: 'ROOMS',
  driverType: 'FIXED', driverInput: null, isWageBase: false, typed: nulls(), override: nulls(), ...p,
});
const jan = (v: number) => { const a = nulls(); a[0] = v; return a; };

function rooms() {
  const stats = emptyStats(2026);
  stats.roomsSold[0] = 1167.9;
  const rev = line({ account: '4001', name: 'Chalets', kind: 'REVENUE', driverType: 'TYPED', typed: jan(242749.17) });
  const wages = line({ account: '6003', name: 'Staff Wages', driverType: 'PER_OCC_ROOM', driverInput: 25.8403536105498, isWageBase: true, isPayroll: true });
  const ot = line({ account: '6004', name: 'Overtime', driverType: 'PCT_WAGES', driverInput: 0.023309, isPayroll: true });
  const pto = line({ account: '6005', name: 'PTO', driverType: 'PCT_WAGES', driverInput: 0.04, isPayroll: true });
  const tax = line({ account: '6006', name: 'Payroll Taxes', driverType: 'PCT_WAGES', driverInput: 0.09, isPayroll: true });
  const comm = line({ account: '6410', name: 'Commissions', driverType: 'PCT_REVENUE', driverInput: 0.009 });
  return { stats, lines: [rev, wages, ot, pto, tax, comm], rev, wages, ot, pto, tax, comm };
}

describe('Rooms, January (the workbook example)', () => {
  const r = rooms();
  const { byLine, result } = computeDept('20', r.lines, r.stats);
  it('CPOR 25.8403536105498 x 1,167.9 occupied rooms = 30,178.95', () => {
    expect(round2(byLine[r.wages.id][0])).toBe(30178.95);
  });
  it('overtime 2.3309% of wages = 703.46 (within 2 cents: the kit prints the rate rounded)', () => {
    expect(Math.abs(byLine[r.ot.id][0] - 703.46)).toBeLessThan(0.03);
  });
  it('commissions 0.9% of 242,749.17 = 2,184.74', () => {
    expect(round2(byLine[r.comm.id][0])).toBe(2184.74);
  });
  it('department profit = revenue - payroll - non-payroll', () => {
    expect(result.profit[0]).toBeCloseTo(result.revenue[0] - result.payroll[0] - result.nonPayroll[0], 6);
    expect(result.wages[0]).toBeCloseTo(byLine[r.wages.id][0], 6);
  });
  it('a manual override wins over the driver', () => {
    const o = { ...r.ot, override: jan(1000) };
    const res = computeDept('20', [r.rev, r.wages, o], r.stats);
    expect(res.byLine[o.id][0]).toBe(1000);
  });
});

describe('levers', () => {
  const lever = (p: Partial<Adjustment>): Adjustment => ({
    id: 1, label: 'Hourly wages +3%', enabled: true, targetType: 'ACCOUNT', account: '6003', appliesTo: 'COST',
    mode: 'PCT', value: 3, fromMonth: 0, toMonth: 11, ...p,
  });
  it('a switched-off lever changes nothing', () => {
    const r = rooms();
    const a = computeScenario(r.lines, r.stats, []);
    const b = computeScenario(r.lines, r.stats, [lever({ enabled: false })]);
    expect(b.byLine).toEqual(a.byLine);
  });
  it('+3% on wages raises overtime, PTO and payroll taxes by the same 3%', () => {
    const r = rooms();
    const a = computeScenario(r.lines, r.stats, []);
    const b = computeScenario(r.lines, r.stats, [lever({})]);
    for (const l of [r.wages, r.ot, r.pto, r.tax]) expect(b.byLine[l.id][0] / a.byLine[l.id][0]).toBeCloseTo(1.03, 10);
    expect(b.byLine[r.comm.id][0]).toBeCloseTo(a.byLine[r.comm.id][0], 10);
  });
  it('a department-wide % lever does not hit derived lines twice', () => {
    const r = rooms();
    const a = computeScenario(r.lines, r.stats, []);
    const b = computeScenario(r.lines, r.stats, [lever({ targetType: 'DEPT', deptId: '20', account: null, value: 5 })]);
    expect(b.byLine[r.ot.id][0] / a.byLine[r.ot.id][0]).toBeCloseTo(1.05, 10);
  });
  it('rent +$30,000 a month from January', () => {
    const rent = line({ deptId: '95', sheet: 'Property&Other Taxes', account: '6900', summaryRow: 'PROPERTY_TAXES', typed: zeros().map(() => 10000) });
    const b = computeScenario([rent], emptyStats(2027), [lever({ deptId: '95', account: '6900', mode: 'ADD', value: 30000 })]);
    expect(sum(b.byLine[rent.id])).toBe(12 * 40000);
  });
  it('an occupancy lever moves CPOR wages and typed room revenue together', () => {
    const r = rooms();
    const a = computeScenario(r.lines, r.stats, []);
    const b = computeScenario(r.lines, r.stats, [lever({ targetType: 'STAT', statKey: 'ROOMS_SOLD', account: null, appliesTo: 'BOTH', value: 10 })]);
    expect(b.byLine[r.wages.id][0] / a.byLine[r.wages.id][0]).toBeCloseTo(1.1, 10);
    expect(b.byLine[r.rev.id][0] / a.byLine[r.rev.id][0]).toBeCloseTo(1.1, 10);
  });
});

describe('statistics', () => {
  it('January 2025 occupancy 1,417 / 3,286 = 43.12%', () => {
    const s = emptyStats(2025);
    s.roomsSold[0] = 1417;
    expect(s.roomCount * s.days[0]).toBe(3286);
    expect(round2(occupancyPct(s)[0])).toBe(43.12);
  });
  it('fill the year from last year\'s shape keeps the total', () => {
    const shape = [656072, 627922, 812288, 957352, 1621076, 2041177, 2575131, 1945207, 1500477, 1330104, 985218, 846095];
    const out = spreadByShape(17_000_000, shape);
    expect(sum(out)).toBeCloseTo(17_000_000, 4);
    expect(out[6]).toBeGreaterThan(out[1] * 4);
  });
});

describe('Summary P&L', () => {
  it('rolls up by summary row and ties: revenue - every cost = NI less owner', () => {
    const mk = (deptId: string, row: string, kind: 'REVENUE' | 'COST', v: number, sheet = '') =>
      line({ deptId, sheet, summaryRow: row, kind, driverType: 'TYPED', typed: jan(v) });
    const ls = [
      mk('20', 'ROOMS', 'REVENUE', 1000), mk('10', 'F&B', 'REVENUE', 500), mk('70', 'OTHER_OPERATED', 'REVENUE', 200),
      mk('25', 'MISC_INCOME', 'REVENUE', 50), mk('20', 'ROOMS', 'COST', 300), mk('10', 'F&B', 'COST', 350),
      mk('70', 'OTHER_OPERATED', 'COST', 150), mk('30', 'A&G', 'COST', 100), mk('35', 'UTILITIES', 'COST', 40),
      mk('90', 'NONOP_INCOME', 'REVENUE', 80), mk('90', 'NONOP_INCOME', 'COST', 30),
      mk('95', 'INSURANCE', 'COST', 60), mk('95', '', 'COST', 20, 'Property&Other Taxes'),
      mk('97', '', 'COST', 5), mk('96', '', 'COST', 70), mk('94', '', 'COST', 90), mk('99', '', 'COST', 25),
    ];
    const res = computeScenario(ls, emptyStats(2027));
    const s = summarizeScenario(ls, res.byLine);
    expect(s.total_rev[0]).toBe(1750);
    expect(s.dept_profit[0]).toBe(950);
    expect(s.gop[0]).toBe(810);
    expect(s.nonop_income[0]).toBe(50);
    expect(s.ebitda[0]).toBe(810 + 50 - 60 - 20);
    expect(s.net_income[0]).toBe(780 - 5 - 70 - 90);
    expect(s.ni_less_owner[0]).toBe(590);
  });
  it('understands the different spellings of a summary row', () => {
    expect(normalizeBucket('F&B')).toBe('FB');
    expect(normalizeBucket('NONOP_INCOME')).toBe('NONOP_INCOME');
    expect(normalizeBucket('', '95', 'Insurance')).toBe('INSURANCE');
    expect(normalizeBucket('', '95', 'Property&Other Taxes')).toBe('PROPERTY_TAXES');
    expect(normalizeBucket(null, '71')).toBe('ROOMS');
  });
});

describe('cash and sensitivity', () => {
  it('ending cash = opening + all movements', () => {
    const items = { opening_balance: jan(500000), capex: zeros().map(() => -10000), ar_collections: jan(2500) };
    const c = computeCash(items, zeros().map(() => 100000), zeros().map(() => 50000));
    expect(c.check).toBe(0);
    expect(c.rows.ending[0]).toBe(500000 + 100000 + 2500 - 10000 - 50000);
    expect(c.rows.opening[1]).toBe(c.rows.ending[0]);
  });
  it('sensitivity centre cell equals the scenario net income', () => {
    const r = rooms();
    const base = sum(summarizeScenario(r.lines, computeScenario(r.lines, r.stats).byLine).net_income);
    const s = sensitivity(r.lines, r.stats, []);
    expect(s.grid[2][2]).toBeCloseTo(base, 6);
    expect(s.grid[4][4]).toBeGreaterThan(s.grid[0][0]);
  });
});
