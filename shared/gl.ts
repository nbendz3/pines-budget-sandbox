// Parser for Sage Intacct's General Ledger report export (CSV).
// Pure functions only, so the tests and the server share them. Nothing here talks to Sage.
import Papa from 'papaparse';

export interface ActualRow { entity: string; dept: string | null; account: string; ym: string; amount: number }
export interface MonthTotal { ym: string; revenue: number; cost: number; netIncome: number; noDept: number; lines: number }
export interface GLParse {
  rows: ActualRow[];
  lineCount: number;
  months: MonthTotal[];
  accounts: string[];
  depts: string[];
  entities: string[];
  skipped: number;
  problems: string[];
}

const isRev = (account: string) => account >= '4000' && account <= '4999';

export function parseMoney(v: unknown): number {
  if (v === null || v === undefined) return 0;
  let s = String(v).trim();
  if (!s) return 0;
  const neg = /^\(.*\)$/.test(s) || s.startsWith('-');
  s = s.replace(/[$,()\s-]/g, '');
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return neg ? -n : n;
}
const cents = (v: unknown) => Math.round(parseMoney(v) * 100);

/** "20--Rooms", "20 - Rooms", "20" -> "20". Names with no number are returned as typed. */
export function parseDept(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,4})\b/);
  return m ? String(Number(m[1])) : s;
}
export function parseEntity(v: unknown): string {
  const s = String(v ?? '').trim();
  const m = s.match(/^(E\d+)/i);
  return m ? m[1].toUpperCase() : s || 'E100';
}
/** MM/DD/YYYY (or YYYY-MM-DD) -> YYYY-MM */
export function parseYm(v: unknown): string | null {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{2})(-\d{2})?/);
  if (m) return `${m[1]}-${m[2]}`;
  return null;
}

/**
 * Header: Posted dt.,Doc dt.,Doc,Memo/Description,Department,Location,Txn No,JNL,Debit,Credit,Balance
 * Account header rows look like "4001 - Chalets (Balance forward As of 07/01/2026) ,,,,,,,,,,0.00".
 * amount = Credit - Debit for accounts 4000-4999, Debit - Credit for everything else,
 * so revenue and costs are both stored as positive numbers.
 */
export function parseSageGL(text: string): GLParse {
  const parsed = Papa.parse<string[]>(text.replace(/^﻿/, ''), { skipEmptyLines: 'greedy' });
  const data = parsed.data as string[][];
  const problems: string[] = [];
  let col = { posted: 0, dept: 4, loc: 5, debit: 8, credit: 9 };
  let account: string | null = null;
  let lineCount = 0;
  let skipped = 0;
  const agg = new Map<string, number>();
  const perMonth = new Map<string, { rev: number; cost: number; noDept: number; lines: number }>();

  for (const r of data) {
    const first = String(r[0] ?? '').trim();
    const lower = r.map((c) => String(c ?? '').trim().toLowerCase());
    if (lower.includes('debit') && lower.includes('credit')) {
      const find = (names: string[], fallback: number) => {
        const i = lower.findIndex((c) => names.includes(c));
        return i >= 0 ? i : fallback;
      };
      col = {
        posted: find(['posted dt.', 'posted dt', 'posted date'], 0),
        dept: find(['department', 'dept'], 4),
        loc: find(['location', 'entity'], 5),
        debit: find(['debit'], 8),
        credit: find(['credit'], 9),
      };
      continue;
    }
    const head = first.match(/^(\d{4})\s*-\s*\S/);
    if (head && !parseYm(first)) { account = head[1]; continue; }
    const ym = parseYm(r[col.posted]);
    if (!ym) { if (first) skipped++; continue; } // totals, balance rows, notes
    if (!account) { problems.push(`Line dated ${first} appears before any account header`); continue; }
    const debit = cents(r[col.debit]);
    const credit = cents(r[col.credit]);
    if (!debit && !credit) { skipped++; continue; }
    const amount = isRev(account) ? credit - debit : debit - credit;
    const entity = parseEntity(r[col.loc]);
    const dept = parseDept(r[col.dept]);
    const key = `${entity}|${dept ?? ''}|${account}|${ym}`;
    agg.set(key, (agg.get(key) ?? 0) + amount);
    const pm = perMonth.get(ym) ?? { rev: 0, cost: 0, noDept: 0, lines: 0 };
    if (isRev(account)) pm.rev += amount; else pm.cost += amount;
    if (dept === null) pm.noDept += isRev(account) ? amount : -amount;
    pm.lines++;
    perMonth.set(ym, pm);
    lineCount++;
  }

  const rows: ActualRow[] = [];
  for (const [key, c] of agg) {
    const [entity, dept, acct, ym] = key.split('|');
    rows.push({ entity, dept: dept || null, account: acct, ym, amount: c / 100 });
  }
  const months: MonthTotal[] = [...perMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([ym, v]) => ({
    ym, revenue: v.rev / 100, cost: v.cost / 100, netIncome: (v.rev - v.cost) / 100, noDept: v.noDept / 100, lines: v.lines,
  }));
  const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))].sort();
  if (!lineCount) problems.push('No ledger lines found. Is this the Sage General Ledger report saved as CSV?');
  return {
    rows, lineCount, months, skipped, problems,
    accounts: uniq(rows.map((r) => r.account)),
    depts: uniq(rows.map((r) => r.dept)),
    entities: uniq(rows.map((r) => r.entity)),
  };
}

/** Anything the reference tables do not know blocks the save. */
export function validateGL(p: GLParse, known: { accounts: Set<string>; depts: Set<string>; entities: Set<string> }) {
  const unknownAccounts = p.accounts.filter((a) => !known.accounts.has(a));
  const unknownDepts = p.depts.filter((d) => !known.depts.has(d));
  const unknownEntities = p.entities.filter((e) => !known.entities.has(e));
  return {
    unknownAccounts, unknownDepts, unknownEntities,
    ok: p.lineCount > 0 && !unknownAccounts.length && !unknownDepts.length && !unknownEntities.length,
  };
}

export interface Expected { ym: string; revenue: number | null; netIncome: number | null }
/** Accepts pasted rows like "2026-10, 1390209.21, 34473.19" or "10/2026 1,390,209.21 34,473.19". */
export function parseExpected(text: string): Expected[] {
  const out: Expected[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^"?(\d{4})-(\d{1,2})"?|^"?(\d{1,2})\/(\d{4})"?/);
    if (!m) continue;
    const ym = m[1] ? `${m[1]}-${m[2].padStart(2, '0')}` : `${m[4]}-${m[3].padStart(2, '0')}`;
    const rest = line.slice(m[0].length);
    const nums = [...rest.matchAll(/\(?-?\$?\d[\d,]*(?:\.\d+)?\)?/g)].map((x) => parseMoney(x[0]));
    out.push({ ym, revenue: nums[0] ?? null, netIncome: nums[1] ?? null });
  }
  return out;
}
export function tieOut(months: MonthTotal[], expected: Expected[]) {
  return expected.map((e) => {
    const got = months.find((m) => m.ym === e.ym);
    const dRev = e.revenue === null || !got ? null : Math.round((got.revenue - e.revenue) * 100) / 100;
    const dNi = e.netIncome === null || !got ? null : Math.round((got.netIncome - e.netIncome) * 100) / 100;
    const ok = !!got && (dRev === null || Math.abs(dRev) <= 0.01) && (dNi === null || Math.abs(dNi) <= 0.01);
    return { ym: e.ym, found: !!got, expectedRevenue: e.revenue, expectedNetIncome: e.netIncome,
      revenue: got?.revenue ?? null, netIncome: got?.netIncome ?? null, diffRevenue: dRev, diffNetIncome: dNi, ok };
  });
}
