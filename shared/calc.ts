// Pines Budget Sandbox - calculation engine.
// ALL budget math lives in this file. The screens, the Excel export and the tests
// import from here so they cannot disagree. Month index is 0..11 (Jan..Dec).

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export type DriverType =
  | 'TYPED' | 'FIXED' | 'PCT_REVENUE' | 'PCT_WAGES' | 'PER_OCC_ROOM' | 'PER_COVER'
  | 'GROWTH_OVER_PY' | 'FTE_HOURS' | 'ROOMS_X_ADR' | 'COVERS_X_CHECK';

export const DRIVER_LABELS: Record<DriverType, string> = {
  TYPED: 'Typed',
  FIXED: 'Fixed',
  PCT_REVENUE: '% of Revenue',
  PCT_WAGES: '% of Wages',
  PER_OCC_ROOM: 'CPOR (per occupied room)',
  PER_COVER: 'CPC (per cover)',
  GROWTH_OVER_PY: 'Growth over last year',
  FTE_HOURS: 'FTE x hours x rate',
  ROOMS_X_ADR: 'Rooms sold x ADR',
  COVERS_X_CHECK: 'Covers x avg check',
};
export const PCT_DRIVERS: DriverType[] = ['PCT_REVENUE', 'PCT_WAGES', 'GROWTH_OVER_PY'];
/** Drivers whose month values come from something else (not typed by hand). */
export const DERIVED_DRIVERS: DriverType[] = [
  'PCT_REVENUE', 'PCT_WAGES', 'PER_OCC_ROOM', 'PER_COVER', 'GROWTH_OVER_PY', 'FTE_HOURS', 'ROOMS_X_ADR', 'COVERS_X_CHECK',
];
export const STAT_DRIVERS: DriverType[] = ['PER_OCC_ROOM', 'PER_COVER', 'ROOMS_X_ADR', 'COVERS_X_CHECK'];

export type Num12 = number[];
export type Opt12 = (number | null)[];

export interface Line {
  id: number;
  entityId?: string;
  deptId: string;
  sheet: string;
  account: string;
  name: string;
  kind: 'REVENUE' | 'COST';
  summaryRow: string;
  category?: string;
  driverType: DriverType;
  driverInput: number | null;
  isWageBase: boolean;
  isPayroll?: boolean;
  isCustom?: boolean;
  fteCount?: number | null;
  fteHours?: number | null;
  fteRate?: number | null;
  typed: Opt12;
  override: Opt12;
  /** Same month last year (actuals plus switched-on normalizations). */
  py?: Opt12;
  sort?: number;
}

export interface Stats {
  roomCount: number;
  days: Num12;
  ooo: Num12;
  roomsSold: Num12;
  adr: Num12;
  /** Occupied rooms for departments other than the Rooms department (rental homes). */
  occRooms: Record<string, Num12>;
  covers: Record<string, Num12>;
  avgCheck: Record<string, Num12>;
}

export type StatKey = 'OCC_PTS' | 'ROOMS_SOLD' | 'COVERS';

export interface Adjustment {
  id: number;
  label: string;
  enabled: boolean;
  targetType: 'ALL' | 'DEPT' | 'ACCOUNT' | 'LINE' | 'STAT';
  deptId?: string | null;
  /** One account, a comma list, or a range: "6003", "4001,4002", "5184-5196". */
  account?: string | null;
  lineId?: number | null;
  statKey?: StatKey | null;
  appliesTo: 'REVENUE' | 'COST' | 'BOTH';
  /** PCT = percent change, ADD = add $ per month, SET = set $ per month,
   *  PTS_OF_REV = add N points of the department's revenue (once per department). */
  mode: 'PCT' | 'ADD' | 'SET' | 'PTS_OF_REV';
  value: number;
  fromMonth: number;
  toMonth: number;
}

export interface EngineOptions {
  roomsDept: string;
  /** Room revenue accounts that move with rooms sold when an occupancy lever is on. */
  roomRevAccounts: string[];
}
export const DEFAULT_OPTIONS: EngineOptions = { roomsDept: '20', roomRevAccounts: ['4001', '4002'] };

export interface DeptResult {
  deptId: string;
  revenue: Num12;
  wages: Num12;
  payroll: Num12;
  nonPayroll: Num12;
  expenses: Num12;
  profit: Num12;
}
export interface ScenarioResult {
  byLine: Record<number, Num12>;
  depts: Record<string, DeptResult>;
  stats: Stats;
}

// ---------- small helpers ----------
export const zeros = (): Num12 => new Array(12).fill(0);
export const nulls = (): Opt12 => new Array(12).fill(null);
export const sum = (a: ArrayLike<number | null | undefined>): number => {
  let t = 0;
  for (let i = 0; i < a.length; i++) t += Number(a[i] ?? 0) || 0;
  return t;
};
export const add12 = (a: Num12, b: ArrayLike<number | null | undefined>): Num12 => a.map((v, i) => v + (Number(b[i] ?? 0) || 0));
export const sub12 = (a: Num12, b: Num12): Num12 => a.map((v, i) => v - (b[i] || 0));
export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
export const ymOf = (year: number, m: number): string => `${year}-${String(m + 1).padStart(2, '0')}`;
export function daysInMonths(year: number): Num12 {
  return MONTHS.map((_, m) => new Date(Date.UTC(year, m + 1, 0)).getUTCDate());
}
export function emptyStats(year: number, roomCount = 106): Stats {
  return { roomCount, days: daysInMonths(year), ooo: zeros(), roomsSold: zeros(), adr: zeros(), occRooms: {}, covers: {}, avgCheck: {} };
}
/** rooms available = room count x days, minus out-of-order room nights */
export function roomsAvailable(s: Stats): Num12 {
  return s.days.map((d, m) => s.roomCount * d - (s.ooo[m] || 0));
}
/** occupancy % = rooms sold / (room count x days)  (HMS convention; OOO not removed) */
export function occupancyPct(s: Stats): Num12 {
  return s.days.map((d, m) => (s.roomCount * d ? (100 * (s.roomsSold[m] || 0)) / (s.roomCount * d) : 0));
}
export function revPar(s: Stats): Num12 {
  return s.days.map((d, m) => (s.roomCount * d ? ((s.roomsSold[m] || 0) * (s.adr[m] || 0)) / (s.roomCount * d) : 0));
}
/** Seasonality helper: spread a yearly total by last year's monthly share. */
export function spreadByShape(total: number, shape: ArrayLike<number | null | undefined>): Num12 {
  const t = sum(shape);
  if (!t) return zeros().map(() => total / 12);
  return Array.from({ length: 12 }, (_, m) => (total * (Number(shape[m] ?? 0) || 0)) / t);
}

export function accountMatches(spec: string | null | undefined, account: string): boolean {
  if (!spec) return true;
  const a = Number(account);
  return spec.split(',').some((part) => {
    const p = part.trim();
    if (!p) return false;
    const r = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (r) return a >= Number(r[1]) && a <= Number(r[2]);
    return p === account;
  });
}

function inWindow(a: Adjustment, m: number): boolean {
  return a.enabled && m >= a.fromMonth && m <= a.toMonth;
}
function kindOk(a: Adjustment, l: Line): boolean {
  return a.appliesTo === 'BOTH' || a.appliesTo === l.kind;
}
export function leverMatchesLine(a: Adjustment, l: Line): boolean {
  if (a.targetType === 'STAT') return false;
  if (!kindOk(a, l)) return false;
  switch (a.targetType) {
    case 'ALL': return true;
    case 'DEPT': return a.deptId === l.deptId;
    case 'ACCOUNT': return accountMatches(a.account, l.account) && (!a.deptId || a.deptId === l.deptId);
    case 'LINE': return a.lineId === l.id;
  }
  return false;
}

/** Apply occupancy / covers levers to the statistics. Returns a new Stats. */
export function applyStatLevers(stats: Stats, adjustments: Adjustment[]): Stats {
  const out: Stats = {
    ...stats,
    roomsSold: [...stats.roomsSold],
    covers: Object.fromEntries(Object.entries(stats.covers).map(([k, v]) => [k, [...v]])),
  };
  for (const a of adjustments) {
    if (!a.enabled || a.targetType !== 'STAT') continue;
    for (let m = a.fromMonth; m <= a.toMonth && m < 12; m++) {
      if (a.statKey === 'OCC_PTS') out.roomsSold[m] += (a.value / 100) * stats.roomCount * stats.days[m];
      else if (a.statKey === 'ROOMS_SOLD') out.roomsSold[m] *= 1 + a.value / 100;
      else if (a.statKey === 'COVERS') {
        for (const d of Object.keys(out.covers)) if (!a.deptId || a.deptId === d) out.covers[d][m] *= 1 + a.value / 100;
      }
      if (out.roomsSold[m] < 0) out.roomsSold[m] = 0;
    }
  }
  return out;
}

function occRoomsFor(dept: string, s: Stats, o: EngineOptions): Num12 {
  if (dept === o.roomsDept) return s.roomsSold;
  return s.occRooms[dept] ?? zeros();
}

/**
 * Compute one department. Order matches the workbook:
 *   1. revenue lines   2. staff-wage (wage base) lines   3. every other cost.
 * A manual override on a month wins over the driver. Levers are applied to a line
 * BEFORE the lines that depend on it, so +3% on wages lifts overtime, PTO and taxes by 3% too.
 */
export function computeDept(
  deptId: string,
  lines: Line[],
  stats: Stats,
  adjustments: Adjustment[] = [],
  baseStats: Stats = stats,
  options: EngineOptions = DEFAULT_OPTIONS,
): { result: DeptResult; byLine: Record<number, Num12> } {
  const byLine: Record<number, Num12> = {};
  const occ = occRoomsFor(deptId, stats, options);
  const covers = stats.covers[deptId] ?? zeros();
  const check = stats.avgCheck[deptId] ?? zeros();
  const revenue = zeros();
  const wages = zeros();
  const payroll = zeros();
  const nonPayroll = zeros();
  const ptsUsed = new Set<string>();

  const baseValue = (l: Line, m: number): number => {
    const ov = l.override?.[m];
    if (ov !== null && ov !== undefined) return ov;
    const r = l.driverInput ?? 0;
    switch (l.driverType) {
      case 'PCT_REVENUE': return r * revenue[m];
      case 'PCT_WAGES': return r * wages[m];
      case 'PER_OCC_ROOM': return r * (occ[m] || 0);
      case 'PER_COVER': return r * (covers[m] || 0);
      case 'GROWTH_OVER_PY': return (l.py?.[m] ?? 0) * (1 + r);
      case 'FTE_HOURS': return (l.fteCount ?? 0) * (l.fteHours ?? 0) * (l.fteRate ?? 0);
      case 'ROOMS_X_ADR': return (stats.roomsSold[m] || 0) * (stats.adr[m] || 0) * (l.driverInput ?? 1);
      case 'COVERS_X_CHECK': return (covers[m] || 0) * (check[m] || 0) * (l.driverInput ?? 1);
      case 'FIXED': return l.typed?.[m] ?? l.driverInput ?? 0;
      default: return l.typed?.[m] ?? 0;
    }
  };

  const isOverridden = (l: Line, m: number) => l.override?.[m] !== null && l.override?.[m] !== undefined;

  const withLevers = (l: Line, m: number, v0: number): number => {
    let v = v0;
    // Typed room revenue follows rooms sold when an occupancy lever moved it (ADR held constant).
    if (
      l.kind === 'REVENUE' && deptId === options.roomsDept && options.roomRevAccounts.includes(l.account) &&
      l.driverType !== 'ROOMS_X_ADR' && l.driverType !== 'PER_OCC_ROOM'
    ) {
      const b = baseStats.roomsSold[m] || 0;
      const s = stats.roomsSold[m] || 0;
      if (b > 0 && s !== b) v *= s / b;
    }
    for (const a of adjustments) {
      if (!inWindow(a, m) || !leverMatchesLine(a, l)) continue;
      if (a.mode === 'PCT') {
        // Do not double count: a broad % lever already reaches a derived line through its base.
        const broad = a.targetType === 'ALL' || a.targetType === 'DEPT';
        if (broad && !isOverridden(l, m)) {
          if (l.driverType === 'PCT_WAGES' && a.appliesTo !== 'REVENUE') continue;
          if (l.driverType === 'PCT_REVENUE' && a.appliesTo !== 'COST') continue;
        }
        v *= 1 + a.value / 100;
      } else if (a.mode === 'ADD') v += a.value;
      else if (a.mode === 'SET') v = a.value;
      else if (a.mode === 'PTS_OF_REV' && l.kind === 'COST') {
        const key = `${a.id}:${m}`;
        if (!ptsUsed.has(key)) { ptsUsed.add(key); v += (a.value / 100) * revenue[m]; }
      }
    }
    return v;
  };

  const run = (subset: Line[], after: (l: Line, vals: Num12) => void) => {
    for (const l of subset) {
      const vals = zeros();
      for (let m = 0; m < 12; m++) vals[m] = withLevers(l, m, baseValue(l, m));
      byLine[l.id] = vals;
      after(l, vals);
    }
  };

  const rev = lines.filter((l) => l.kind === 'REVENUE');
  const cost = lines.filter((l) => l.kind === 'COST');
  // 1a. revenue that does not depend on revenue
  const revA = zeros();
  const tmpRevenue = (vals: Num12, target: Num12) => { for (let m = 0; m < 12; m++) target[m] += vals[m]; };
  run(rev.filter((l) => l.driverType !== 'PCT_REVENUE'), (_l, v) => tmpRevenue(v, revA));
  for (let m = 0; m < 12; m++) revenue[m] = revA[m];
  // 1b. revenue lines that are a % of the other revenue (discounts and the like)
  const revB = zeros();
  run(rev.filter((l) => l.driverType === 'PCT_REVENUE'), (_l, v) => tmpRevenue(v, revB));
  for (let m = 0; m < 12; m++) revenue[m] = revA[m] + revB[m];
  // 2. wage base
  const bucket = (l: Line, v: Num12) => {
    const t = l.isPayroll ? payroll : nonPayroll;
    for (let m = 0; m < 12; m++) t[m] += v[m];
  };
  run(cost.filter((l) => l.isWageBase && l.driverType !== 'PCT_WAGES'), (l, v) => {
    for (let m = 0; m < 12; m++) wages[m] += v[m];
    bucket(l, v);
  });
  // 3. everything else
  run(cost.filter((l) => !(l.isWageBase && l.driverType !== 'PCT_WAGES')), bucket);

  const expenses = add12(payroll, nonPayroll);
  return {
    byLine,
    result: { deptId, revenue, wages, payroll, nonPayroll, expenses, profit: sub12(revenue, expenses) },
  };
}

export function computeScenario(
  lines: Line[],
  stats: Stats,
  adjustments: Adjustment[] = [],
  options: EngineOptions = DEFAULT_OPTIONS,
): ScenarioResult {
  const adj = adjustments.filter((a) => a.enabled);
  const s2 = applyStatLevers(stats, adj);
  const groups = new Map<string, Line[]>();
  for (const l of lines) {
    if (!groups.has(l.deptId)) groups.set(l.deptId, []);
    groups.get(l.deptId)!.push(l);
  }
  const byLine: Record<number, Num12> = {};
  const depts: Record<string, DeptResult> = {};
  for (const [deptId, ls] of groups) {
    const r = computeDept(deptId, ls, s2, adj, stats, options);
    Object.assign(byLine, r.byLine);
    depts[deptId] = r.result;
  }
  return { byLine, depts, stats: s2 };
}

// ---------- Summary P&L (the workbook's layout) ----------
export type Bucket =
  | 'ROOMS' | 'FB' | 'OTHER_OPERATED' | 'MISC_INCOME'
  | 'AG' | 'IT' | 'RM' | 'SM' | 'UTILITIES' | 'NO_DEPT'
  | 'NONOP_INCOME' | 'INSURANCE' | 'PROPERTY_TAXES'
  | 'AMORTIZATION' | 'DEPRECIATION' | 'INTEREST' | 'OWNER';

export const DEPT_BUCKET: Record<string, Bucket> = {
  '20': 'ROOMS', '71': 'ROOMS', '72': 'ROOMS', '73': 'ROOMS', '74': 'ROOMS', '75': 'ROOMS',
  '10': 'FB', '12': 'FB', '13': 'FB', '15': 'FB',
  '17': 'OTHER_OPERATED', '65': 'OTHER_OPERATED', '70': 'OTHER_OPERATED',
  '25': 'MISC_INCOME',
  '30': 'AG', '31': 'IT', '35': 'UTILITIES', '40': 'RM', '50': 'SM',
  '90': 'NONOP_INCOME', '91': 'NONOP_INCOME', '92': 'NONOP_INCOME', '93': 'NONOP_INCOME',
  '94': 'INTEREST', '95': 'PROPERTY_TAXES', '96': 'DEPRECIATION', '97': 'AMORTIZATION', '99': 'OWNER',
};

/** Map any spelling of a Summary P&L row (CSV code, tab name, USALI bucket) to a bucket. */
export function normalizeBucket(raw: string | null | undefined, deptId?: string | null, hint?: string): Bucket {
  const s = `${raw ?? ''}`.toUpperCase().replace(/[^A-Z&]/g, '');
  const h = `${hint ?? ''}`.toUpperCase();
  if (s) {
    if (s.includes('NONOP') || s.includes('NONOPERATINGINCOME')) return 'NONOP_INCOME';
    if (s.includes('INSUR')) return 'INSURANCE';
    if (s.includes('TAX')) return 'PROPERTY_TAXES';
    if (s.includes('AMORT')) return 'AMORTIZATION';
    if (s.includes('DEPREC')) return 'DEPRECIATION';
    if (s.includes('INTEREST')) return 'INTEREST';
    if (s.includes('OWNER')) return 'OWNER';
    if (s.includes('MISC')) return 'MISC_INCOME';
    if (s.includes('ROOM')) return 'ROOMS';
    if (s === 'FB' || s.includes('F&B') || s.includes('FOOD') || s.includes('FNB')) return 'FB';
    if (s.includes('OTHER')) return 'OTHER_OPERATED';
    if (s === 'AG' || s === 'A&G' || s.includes('ADMIN')) return 'AG';
    if (s === 'IT' || s.includes('INFORMATION') || s.includes('TECH')) return 'IT';
    if (s === 'RM' || s === 'R&M' || s.includes('REPAIR') || s.includes('MAINT')) return 'RM';
    if (s === 'SM' || s === 'S&M' || s.includes('SALES') || s.includes('MARKETING')) return 'SM';
    if (s.includes('UTIL')) return 'UTILITIES';
    if (s.includes('NODEP')) return 'NO_DEPT';
  }
  if (deptId === '95' && h.includes('INSUR')) return 'INSURANCE';
  if (deptId && DEPT_BUCKET[deptId]) return DEPT_BUCKET[deptId];
  return 'NO_DEPT';
}

export interface SummaryRowDef { key: string; label: string; style?: 'total' | 'pct' | 'sub' | 'head'; of?: string }
export const SUMMARY_LAYOUT: SummaryRowDef[] = [
  { key: 'h_rev', label: 'Operating Revenue', style: 'head' },
  { key: 'rev_ROOMS', label: 'Rooms Revenue' },
  { key: 'rev_FB', label: 'F&B Revenue' },
  { key: 'rev_OTHER', label: 'Other Departments Revenue' },
  { key: 'rev_MISC', label: 'Miscellaneous Income' },
  { key: 'total_rev', label: 'Total Operating Revenue', style: 'total' },
  { key: 'h_exp', label: 'Departmental Expenses', style: 'head' },
  { key: 'exp_ROOMS', label: 'Rooms Expenses' },
  { key: 'exp_FB', label: 'F&B Expenses' },
  { key: 'exp_OTHER', label: 'Other Departments Expenses' },
  { key: 'total_dept_exp', label: 'Total Departmental Expenses', style: 'total' },
  { key: 'dept_profit', label: 'Total Departmental Profit', style: 'total' },
  { key: 'dept_profit_pct', label: 'Departmental margin', style: 'pct', of: 'dept_profit' },
  { key: 'h_und', label: 'Undistributed Expenses', style: 'head' },
  { key: 'AG', label: 'Administrative & General' },
  { key: 'IT', label: 'Information & Technology' },
  { key: 'RM', label: 'Repairs & Maintenance' },
  { key: 'SM', label: 'Sales & Marketing' },
  { key: 'UTILITIES', label: 'Utilities' },
  { key: 'NO_DEPT', label: 'No department (Sage lines with no department)' },
  { key: 'total_undist', label: 'Total Undistributed', style: 'total' },
  { key: 'total_undist_pct', label: 'Undistributed % of revenue', style: 'pct', of: 'total_undist' },
  { key: 'gop', label: 'Gross Operating Profit', style: 'total' },
  { key: 'gop_pct', label: 'GOP margin', style: 'pct', of: 'gop' },
  { key: 'h_non', label: 'Non-Operating', style: 'head' },
  { key: 'nonop_income', label: 'Non-Operating Income (net of cost)' },
  { key: 'insurance', label: 'Insurance' },
  { key: 'prop_tax', label: 'Property & Other Taxes' },
  { key: 'total_nonop', label: 'Total Non-Operating', style: 'total' },
  { key: 'ebitda', label: 'EBITDA', style: 'total' },
  { key: 'ebitda_pct', label: 'EBITDA margin', style: 'pct', of: 'ebitda' },
  { key: 'amort', label: 'Amortization' },
  { key: 'deprec', label: 'Depreciation' },
  { key: 'interest', label: 'Interest Expense' },
  { key: 'net_income', label: 'Net Income', style: 'total' },
  { key: 'net_income_pct', label: 'Net margin', style: 'pct', of: 'net_income' },
  { key: 'owner', label: 'Owner Expenses' },
  { key: 'ni_less_owner', label: 'NI Less Owner Expenses', style: 'total' },
];

export interface BucketAmount { bucket: Bucket; kind: 'REVENUE' | 'COST'; amounts: ArrayLike<number | null | undefined> }

/** Build the Summary P&L from amounts tagged with a bucket. Works for budgets and for actuals. */
export function summarize(items: BucketAmount[]): Record<string, Num12> {
  const rev: Record<string, Num12> = {};
  const cost: Record<string, Num12> = {};
  for (const it of items) {
    const t = it.kind === 'REVENUE' ? rev : cost;
    t[it.bucket] = add12(t[it.bucket] ?? zeros(), it.amounts);
  }
  const R = (b: Bucket) => rev[b] ?? zeros();
  const C = (b: Bucket) => cost[b] ?? zeros();
  const net = (b: Bucket) => sub12(C(b), R(b)); // cost net of any revenue coded there
  const o: Record<string, Num12> = {};
  o.rev_ROOMS = R('ROOMS'); o.rev_FB = R('FB'); o.rev_OTHER = R('OTHER_OPERATED'); o.rev_MISC = R('MISC_INCOME');
  o.total_rev = [o.rev_ROOMS, o.rev_FB, o.rev_OTHER, o.rev_MISC].reduce(add12, zeros());
  o.exp_ROOMS = C('ROOMS'); o.exp_FB = C('FB'); o.exp_OTHER = add12(C('OTHER_OPERATED'), C('MISC_INCOME'));
  o.total_dept_exp = [o.exp_ROOMS, o.exp_FB, o.exp_OTHER].reduce(add12, zeros());
  o.dept_profit = sub12(o.total_rev, o.total_dept_exp);
  for (const b of ['AG', 'IT', 'RM', 'SM', 'UTILITIES', 'NO_DEPT'] as Bucket[]) o[b] = net(b);
  o.total_undist = [o.AG, o.IT, o.RM, o.SM, o.UTILITIES, o.NO_DEPT].reduce(add12, zeros());
  o.gop = sub12(o.dept_profit, o.total_undist);
  o.nonop_income = sub12(R('NONOP_INCOME'), C('NONOP_INCOME'));
  o.insurance = net('INSURANCE');
  o.prop_tax = net('PROPERTY_TAXES');
  o.total_nonop = sub12(sub12(o.nonop_income, o.insurance), o.prop_tax);
  o.ebitda = add12(o.gop, o.total_nonop);
  o.amort = net('AMORTIZATION'); o.deprec = net('DEPRECIATION'); o.interest = net('INTEREST');
  o.net_income = sub12(sub12(sub12(o.ebitda, o.amort), o.deprec), o.interest);
  o.owner = net('OWNER');
  o.ni_less_owner = sub12(o.net_income, o.owner);
  const pct = (a: Num12) => a.map((v, m) => (o.total_rev[m] ? (100 * v) / o.total_rev[m] : 0));
  o.dept_profit_pct = pct(o.dept_profit); o.total_undist_pct = pct(o.total_undist); o.gop_pct = pct(o.gop);
  o.ebitda_pct = pct(o.ebitda); o.net_income_pct = pct(o.net_income);
  return o;
}

export function summarizeScenario(lines: Line[], byLine: Record<number, Num12>): Record<string, Num12> {
  return summarize(lines.map((l) => ({
    bucket: normalizeBucket(l.summaryRow, l.deptId, l.sheet), kind: l.kind, amounts: byLine[l.id] ?? zeros(),
  })));
}

/** Year total for a summary row; percentage rows are recomputed from year totals. */
export function summaryTotal(s: Record<string, Num12>, def: SummaryRowDef): number {
  if (def.style === 'pct' && def.of) {
    const r = sum(s.total_rev);
    return r ? (100 * sum(s[def.of])) / r : 0;
  }
  return sum(s[def.key] ?? []);
}

// ---------- Sage layout ----------
export const SAGE_SECTIONS = [
  'Revenue', 'Cost of Goods Sold', 'Cost of Services Revenue', 'General and Administrative',
  'Depreciation and Amortization', 'Payroll and Related', 'Utilities and Facilities',
  'Operating and Maintenance', 'Taxes and Insurance', 'Other Expense',
];
export function sageSection(plSection: string | null | undefined, account: string): string {
  const s = (plSection ?? '').toLowerCase();
  if (s) {
    if (s.includes('cost of goods')) return 'Cost of Goods Sold';
    if (s.includes('cost of services')) return 'Cost of Services Revenue';
    if (s.includes('general')) return 'General and Administrative';
    if (s.includes('deprec')) return 'Depreciation and Amortization';
    if (s.includes('payroll')) return 'Payroll and Related';
    if (s.includes('utilit')) return 'Utilities and Facilities';
    if (s.includes('operating and maint')) return 'Operating and Maintenance';
    if (s.includes('tax')) return 'Taxes and Insurance';
    if (s.includes('other')) return 'Other Expense';
    if (s.includes('revenue') || s.includes('income')) return 'Revenue';
  }
  return account.startsWith('4') ? 'Revenue' : 'Other Expense';
}
export const isRevenueAccount = (account: string) => account >= '4000' && account <= '4999';

// ---------- Cash flow ----------
export interface CashRowDef { key: string; label: string; section: 'open' | 'operating' | 'investing' | 'financing' | 'other' | 'total'; computed?: boolean }
export const CASH_ROWS: CashRowDef[] = [
  { key: 'opening', label: 'Opening Cash Balance', section: 'open', computed: true },
  { key: 'ebitda', label: 'Hotel EBITDA (from the scenario)', section: 'operating', computed: true },
  { key: 'ar_collections', label: 'AR Collections', section: 'operating' },
  { key: 'prepaids', label: 'Prepaids', section: 'operating' },
  { key: 'inventories', label: 'Inventories', section: 'operating' },
  { key: 'advance_deposits', label: 'Advance Deposits', section: 'operating' },
  { key: 'accounts_payable', label: 'Accounts Payable', section: 'operating' },
  { key: 'taxes_payable', label: 'Taxes Payable', section: 'operating' },
  { key: 'accrued_liabilities', label: 'Accrued Liabilities', section: 'operating' },
  { key: 'tot_payment', label: 'TOT payment (cash only, not a P&L expense)', section: 'operating' },
  { key: 'net_operating', label: 'Net Cash from Operations', section: 'total', computed: true },
  { key: 'capex', label: 'Capital Expenditures', section: 'investing' },
  { key: 'asset_sales', label: 'Proceeds from sale of assets', section: 'investing' },
  { key: 'loan_proceeds', label: 'Loan proceeds', section: 'financing' },
  { key: 'principal', label: 'Principal repayments', section: 'financing' },
  { key: 'interest_paid', label: 'Interest paid (from the P&L interest line)', section: 'financing', computed: true },
  { key: 'owner_contributions', label: 'Owner contributions', section: 'financing' },
  { key: 'owner_distributions', label: 'Owner distributions', section: 'financing' },
  { key: 'reserve_funding', label: 'Funding of reserve accounts', section: 'financing' },
  { key: 'restricted_release', label: 'Release of restricted cash', section: 'financing' },
  { key: 'ending', label: 'Ending Cash Balance', section: 'total', computed: true },
];
/**
 * Cash rows are signed: money in is positive, money out is negative.
 * items.opening_balance[0] is the opening cash for January.
 */
export function computeCash(items: Record<string, Opt12 | Num12>, ebitda: Num12, interest: Num12) {
  const rows: Record<string, Num12> = {};
  for (const r of CASH_ROWS) if (!r.computed) rows[r.key] = (items[r.key] ?? zeros()).map((v) => Number(v ?? 0) || 0);
  rows.ebitda = [...ebitda];
  rows.interest_paid = interest.map((v) => -v);
  const op = CASH_ROWS.filter((r) => r.section === 'operating').map((r) => r.key);
  const rest = CASH_ROWS.filter((r) => r.section === 'investing' || r.section === 'financing').map((r) => r.key);
  rows.net_operating = op.reduce((t, k) => add12(t, rows[k]), zeros());
  const movement = rest.reduce((t, k) => add12(t, rows[k]), rows.net_operating);
  rows.opening = zeros(); rows.ending = zeros();
  let bal = Number(items.opening_balance?.[0] ?? 0) || 0;
  for (let m = 0; m < 12; m++) { rows.opening[m] = bal; bal += movement[m]; rows.ending[m] = bal; }
  let lowest = 0;
  for (let m = 1; m < 12; m++) if (rows.ending[m] < rows.ending[lowest]) lowest = m;
  const check = round2(rows.ending[11] - (rows.opening[0] + sum(movement)));
  return { rows, movement, lowestMonth: lowest, check };
}

// ---------- Sensitivity (occupancy points x ADR %) ----------
export function sensitivity(
  lines: Line[], stats: Stats, adjustments: Adjustment[], options: EngineOptions = DEFAULT_OPTIONS,
  occPts = [-4, -2, 0, 2, 4], adrPct = [-6, -3, 0, 3, 6],
) {
  const grid = occPts.map((o) => adrPct.map((a) => {
    const extra: Adjustment[] = [
      { id: -1, label: 'occ', enabled: true, targetType: 'STAT', statKey: 'OCC_PTS', appliesTo: 'BOTH', mode: 'ADD', value: o, fromMonth: 0, toMonth: 11 },
      { id: -2, label: 'adr', enabled: true, targetType: 'ACCOUNT', account: options.roomRevAccounts.join(','), deptId: options.roomsDept, appliesTo: 'REVENUE', mode: 'PCT', value: a, fromMonth: 0, toMonth: 11 },
    ];
    const r = computeScenario(lines, stats, [...adjustments, ...extra], options);
    return sum(summarizeScenario(lines, r.byLine).net_income);
  }));
  return { occPts, adrPct, grid };
}
