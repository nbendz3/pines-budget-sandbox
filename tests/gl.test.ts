import { describe, it, expect } from 'vitest';
import { parseSageGL, validateGL, parseExpected, tieOut } from '../shared/gl';

// Made-up fixture in the exact shape of Sage's General Ledger export. Not real numbers.
const CSV = `Posted dt.,Doc dt.,Doc,Memo/Description,Department,Location,Txn No,JNL,Debit,Credit,Balance
"4001 - Chalets (Balance forward As of 10/01/2026) ",,,,,,,,,,0.00
10/01/2026,10/01/2026,HMS-1,Room revenue,20--Rooms,E100--Home Away Inc.,1001,HMS,,"1,200.50",
10/02/2026,10/02/2026,HMS-2,Refund,20--Rooms,E100--Home Away Inc.,1002,HMS,200.50,,
11/01/2026,11/01/2026,HMS-3,Room revenue,20--Rooms,E100--Home Away Inc.,1003,HMS,,300.00,
Total for 4001 - Chalets,,,,,,,,200.50,"1,500.50",
"6003 - Staff Wages (Balance forward As of 10/01/2026) ",,,,,,,,,,0.00
10/15/2026,10/15/2026,PR-1,Payroll,20--Rooms,E100--Home Away Inc.,2001,PRJ,400.00,,
10/15/2026,10/15/2026,PR-2,Payroll,,E100--Home Away Inc.,2002,PRJ,50.25,,
"9999 - Mystery (Balance forward As of 10/01/2026) ",,,,,,,,,,0.00
10/20/2026,10/20/2026,X,Unknown,88--Nowhere,E100,3001,GJ,10.00,,
`;

describe('Sage GL import', () => {
  const p = parseSageGL(CSV);
  it('reads lines under their account header and skips headers, totals and blanks', () => {
    expect(p.lineCount).toBe(6);
    expect(p.accounts).toEqual(['4001', '6003', '9999']);
  });
  it('revenue is credits minus debits; costs are debits minus credits', () => {
    const rev = p.rows.find((r) => r.account === '4001' && r.ym === '2026-10')!;
    expect(rev.amount).toBe(1000);
    expect(rev.dept).toBe('20');
    expect(rev.entity).toBe('E100');
    const wages = p.rows.filter((r) => r.account === '6003');
    expect(wages.map((w) => w.amount).sort()).toEqual([400, 50.25].sort());
  });
  it('a month of revenue accounts sums to the control total, to the cent', () => {
    const oct = p.months.find((m) => m.ym === '2026-10')!;
    expect(oct.revenue).toBe(1000);
    expect(oct.netIncome).toBe(1000 - 400 - 50.25 - 10);
    const t = tieOut(p.months, parseExpected('2026-10, 1000.00, 539.75\n2026-11, 300.02, 300.00'));
    expect(t[0].ok).toBe(true);
    expect(t[1].ok).toBe(false);
    expect(t[1].diffRevenue).toBe(-0.02);
  });
  it('blank department goes to the "no department" bucket', () => {
    expect(p.rows.some((r) => r.dept === null && r.amount === 50.25)).toBe(true);
    expect(p.months.find((m) => m.ym === '2026-10')!.noDept).toBe(-50.25);
  });
  it('an unknown account or department blocks the save', () => {
    const v = validateGL(p, { accounts: new Set(['4001', '6003']), depts: new Set(['20']), entities: new Set(['E100']) });
    expect(v.ok).toBe(false);
    expect(v.unknownAccounts).toEqual(['9999']);
    expect(v.unknownDepts).toEqual(['88']);
    const ok = validateGL(p, { accounts: new Set(['4001', '6003', '9999']), depts: new Set(['20', '88']), entities: new Set(['E100']) });
    expect(ok.ok).toBe(true);
  });
});
