import { useEffect, useState } from 'react';
import { api, type Ref } from './store';
import { Banner, SAGE_OPEN, fmt } from './ui';
import { normalizeBucket, isRevenueAccount, zeros, MONTHS, type Bucket, type BucketAmount, type Num12 } from '../../shared/calc';

export interface ActualRow { entity_id: string; dept_id: string | null; account: string; ym: string; amount: number }
const cache = new Map<number, ActualRow[]>();
export const clearActualsCache = () => cache.clear();

export function useActuals(year: number | null): ActualRow[] | null {
  const [rows, setRows] = useState<ActualRow[] | null>(year && cache.has(year) ? cache.get(year)! : null);
  useEffect(() => {
    if (!year) { setRows(null); return; }
    if (cache.has(year)) { setRows(cache.get(year)!); return; }
    let live = true;
    setRows(null);
    api<{ rows: ActualRow[] }>(`/actuals?year=${year}`).then((r) => { cache.set(year, r.rows); if (live) setRows(r.rows); }).catch(() => live && setRows([]));
    return () => { live = false; };
  }, [year]);
  return rows;
}

/** Which Summary P&L row an actual belongs to: by department, with a few account rules. */
export function actualBucket(r: ActualRow, ref: Ref): Bucket {
  if (r.account === '7650') return 'AMORTIZATION';
  if (r.account === '7660') return 'DEPRECIATION';
  if (r.account === '6340') return 'INTEREST';
  if (r.dept_id === null) return 'NO_DEPT';
  if (r.dept_id === '95') {
    const name = ref.accounts.find((a) => a.account === r.account)?.name ?? '';
    return /insur/i.test(name) ? 'INSURANCE' : 'PROPERTY_TAXES';
  }
  const d = ref.departments.find((x) => x.dept_id === r.dept_id);
  return normalizeBucket(d?.bucket, r.dept_id);
}
const mi = (ym: string) => Number(ym.slice(5, 7)) - 1;
export function actualItems(rows: ActualRow[], ref: Ref, entity: string): BucketAmount[] {
  return rows.filter((r) => entity === 'ALL' || r.entity_id === entity).map((r) => {
    const a = zeros();
    a[mi(r.ym)] = r.amount;
    return { bucket: actualBucket(r, ref), kind: isRevenueAccount(r.account) ? 'REVENUE' : 'COST', amounts: a };
  });
}
export function actualsByAccount(rows: ActualRow[], entity: string): Record<string, Num12> {
  const out: Record<string, Num12> = {};
  for (const r of rows) {
    if (entity !== 'ALL' && r.entity_id !== entity) continue;
    (out[r.account] ??= zeros())[mi(r.ym)] += r.amount;
  }
  return out;
}

export interface MonthStatus { ym: string; batch_id: number; file_name: string; sage_created_on: string; period_open: boolean; revenue: number; net_income: number; conflicts: any[] }
export function useStatus(dep: any = 0): MonthStatus[] {
  const [s, setS] = useState<MonthStatus[]>([]);
  useEffect(() => { api<{ months: MonthStatus[] }>('/actuals/status').then((r) => setS(r.months)).catch(() => {}); }, [dep]);
  return s;
}
const label = (ym: string) => `${MONTHS[mi(ym)]} ${ym.slice(0, 4)}`;

/** Yellow: months still open in Sage. Red: two imports of the same month that differ by more than $10,000. */
export function ActualsBanners({ status, year }: { status: MonthStatus[]; year?: number }) {
  const mine = status.filter((s) => !year || s.ym.startsWith(`${year}-`));
  if (!mine.length) return null;
  const open = mine.filter((s) => s.period_open);
  const clash = mine.filter((s) => s.conflicts?.length);
  return (
    <>
      {open.length > 0 && (
        <Banner kind="warn"><strong>{SAGE_OPEN}.</strong> Open months loaded: {open.map((s) => label(s.ym)).join(', ')}. Latest Sage “Created on”: {open[open.length - 1].sage_created_on}.</Banner>
      )}
      {clash.map((s) => (
        <Banner kind="bad" key={s.ym}>
          <strong>{label(s.ym)} moved between imports.</strong> The import in use shows revenue {fmt(s.revenue, 2)} and net income {fmt(s.net_income, 2)};
          {' '}{s.conflicts.map((c: any) => `the pull created ${c.sageCreatedOn} showed ${fmt(c.revenue, 2)} and ${fmt(c.netIncome, 2)}`).join('; ')}.
        </Banner>
      ))}
    </>
  );
}
