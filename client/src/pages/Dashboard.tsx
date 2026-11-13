import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line as RLine, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from 'recharts';
import { useApp } from '../store';
import { Page, Card, Banner, Scroll, fmt, money, pct, neg, SAGE_OPEN } from '../ui';
import { useActuals, useStatus, ActualsBanners } from '../actuals';
import { MONTHS, sum, zeros, isRevenueAccount } from '../../../shared/calc';

export const C1 = '#1f5c4a'; export const C2 = '#c2410c'; export const C3 = '#64748b'; export const C4 = '#7c3aed';
const kfmt = (v: number) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : Math.abs(v) >= 1e3 ? `${Math.round(v / 1e3)}k` : `${Math.round(v)}`);

export function Dashboard() {
  const { bundle, summary, result, deptName, cash } = useApp();
  const status = useStatus();
  if (!bundle || !summary || !result) {
    return <Page title="Dashboard"><p className="muted">No scenario yet. Create one on the Scenarios page, or import your budget workbook on the Imports page.</p></Page>;
  }
  const rev = sum(summary.total_rev);
  const tiles: [string, number, number | null][] = [
    ['Revenue', rev, null], ['Departmental Profit', sum(summary.dept_profit), rev], ['GOP', sum(summary.gop), rev],
    ['EBITDA', sum(summary.ebitda), rev], ['Net Income', sum(summary.net_income), rev],
  ];
  const monthly = MONTHS.map((m, i) => ({ month: m, Revenue: Math.round(summary.total_rev[i]), 'Net income': Math.round(summary.net_income[i]) }));
  let low = 0;
  for (let m = 1; m < 12; m++) if (summary.net_income[m] < summary.net_income[low]) low = m;
  const depts = Object.values(result.depts).filter((d) => sum(d.revenue) !== 0)
    .map((d) => ({ dept: deptName(d.deptId), Profit: Math.round(sum(d.profit)) })).sort((a, b) => b.Profit - a.Profit);
  return (
    <Page title="Dashboard" sub={`${bundle.scenario.name} · fiscal year ${bundle.scenario.fiscal_year}`}>
      {bundle.scenario.is_sample && <Banner kind="warn"><strong>Sample data.</strong> These lines and dollar amounts are made up so the app has something to show. Put the real seed files in <code>/seed</code> and press “Reload seed files” on the Imports page, or import your budget workbook.</Banner>}
      <ActualsBanners status={status} />
      <div className="tiles">
        {tiles.map(([label, v, of]) => (
          <div className="tile" key={label}>
            <div className="muted small">{label}</div>
            <div className={`big ${neg(v)}`}>{money(v)}</div>
            <div className="muted small">{of ? `${pct((100 * v) / of)} of revenue` : 'for the year'}</div>
          </div>
        ))}
      </div>
      <Banner kind={summary.net_income[low] < 0 ? 'warn' : 'info'}>
        <strong>Lowest-profit month: {MONTHS[low]}.</strong> Net income {money(summary.net_income[low])} on revenue {money(summary.total_rev[low])}.
        {cash && <> Lowest month-end cash: {MONTHS[cash.lowestMonth]} at {money(cash.rows.ending[cash.lowestMonth])}.</>}
      </Banner>
      <div className="two">
        <Card title="Revenue by month, with net income">
          <div className="chart">
            <ResponsiveContainer>
              <ComposedChart data={monthly} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#e5e7eb" vertical={false} />
                <XAxis dataKey="month" tickLine={false} /><YAxis tickFormatter={kfmt} tickLine={false} axisLine={false} width={48} />
                <Tooltip formatter={(v: number) => money(v)} /><Legend />
                <ReferenceLine y={0} stroke="#94a3b8" />
                <Bar dataKey="Revenue" fill={C1} radius={[3, 3, 0, 0]} />
                <RLine dataKey="Net income" stroke={C2} strokeWidth={2.5} dot={{ r: 3 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card title="Departmental profit by department (year)">
          <div className="chart" style={{ height: Math.max(260, depts.length * 26) }}>
            <ResponsiveContainer>
              <BarChart data={depts} layout="vertical" margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#e5e7eb" horizontal={false} />
                <XAxis type="number" tickFormatter={kfmt} tickLine={false} /><YAxis type="category" dataKey="dept" width={150} tickLine={false} tick={{ fontSize: 12 }} />
                <Tooltip formatter={(v: number) => money(v)} /><ReferenceLine x={0} stroke="#94a3b8" />
                <Bar dataKey="Profit" radius={[0, 3, 3, 0]}>{depts.map((d) => <Cell key={d.dept} fill={d.Profit < 0 ? C2 : C1} />)}</Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>
      <TopChanges />
    </Page>
  );
}

/** Top 10 changes vs last year's actuals, by account across the whole resort. */
function TopChanges() {
  const { bundle, result, ref, fy } = useApp();
  const ly = useActuals(fy - 1);
  const rows = useMemo(() => {
    if (!bundle || !result || !ly?.length) return [];
    const b: Record<string, number> = {}; const a: Record<string, number> = {};
    for (const l of bundle.lines) b[l.account] = (b[l.account] ?? 0) + sum(result.byLine[l.id] ?? zeros());
    for (const r of ly) a[r.account] = (a[r.account] ?? 0) + r.amount;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].map((x) => ({ account: x, name: ref.accounts.find((k) => k.account === x)?.name ?? '',
      budget: b[x] ?? 0, ly: a[x] ?? 0, diff: (b[x] ?? 0) - (a[x] ?? 0), rev: isRevenueAccount(x) }))
      .sort((p, q2) => Math.abs(q2.diff) - Math.abs(p.diff)).slice(0, 10);
  }, [bundle, result, ly, ref]);
  if (!rows.length) return null;
  return (
    <Card title={`Top 10 changes vs ${fy - 1} actuals`}>
      <p className="muted small">{SAGE_OPEN}.</p>
      <Scroll><table className="grid">
        <thead><tr><th>Account</th><th>Type</th><th className="r">Scenario</th><th className="r">{fy - 1} actual</th><th className="r">Change</th><th className="r">%</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.account}><td>{r.account} {r.name}</td><td>{r.rev ? 'Revenue' : 'Cost'}</td><td className="r num">{fmt(r.budget)}</td><td className="r num">{fmt(r.ly)}</td>
            <td className={`r num ${neg(r.diff)}`}>{fmt(r.diff)}</td><td className={`r num ${neg(r.diff)}`}>{r.ly ? pct((100 * r.diff) / Math.abs(r.ly)) : ''}</td></tr>
        ))}</tbody>
      </table></Scroll>
    </Card>
  );
}

export function Actuals() {
  const { ref, deptName, fy } = useApp();
  const status = useStatus();
  const years = [...new Set(status.map((s) => Number(s.ym.slice(0, 4))))].sort();
  const [year, setYear] = useState<number | null>(null);
  const y = year ?? years[years.length - 1] ?? fy - 1;
  const rows = useActuals(y);
  const [month, setMonth] = useState('YTD');
  const [dept, setDept] = useState('ALL');
  const [entity, setEntity] = useState('ALL');
  const data = useMemo(() => {
    const f = (rows ?? []).filter((r) => (entity === 'ALL' || r.entity_id === entity) && (month === 'YTD' || r.ym === `${y}-${month}`));
    const byDept = new Map<string, { rev: number; cost: number }>();
    for (const r of f) {
      const k = r.dept_id ?? '';
      const d = byDept.get(k) ?? { rev: 0, cost: 0 };
      if (isRevenueAccount(r.account)) d.rev += r.amount; else d.cost += r.amount;
      byDept.set(k, d);
    }
    const byAcct = new Map<string, number>();
    for (const r of f) if (dept === 'ALL' || (r.dept_id ?? '') === dept) byAcct.set(r.account, (byAcct.get(r.account) ?? 0) + r.amount);
    return { byDept: [...byDept.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : Number(a) - Number(b))), byAcct: [...byAcct.entries()].sort() };
  }, [rows, entity, month, dept, y]);
  const tot = data.byDept.reduce((t, [, d]) => ({ rev: t.rev + d.rev, cost: t.cost + d.cost }), { rev: 0, cost: 0 });
  const acctRev = data.byAcct.filter(([a]) => isRevenueAccount(a)).reduce((t, [, v]) => t + v, 0);
  const acctCost = data.byAcct.filter(([a]) => !isRevenueAccount(a)).reduce((t, [, v]) => t + v, 0);
  return (
    <Page title="Actuals" sub="What was imported from Sage. For any month, the most recent import that contains it is the one in use.">
      <Banner kind="warn"><strong>{SAGE_OPEN}.</strong></Banner>
      <ActualsBanners status={status.filter((s) => s.conflicts?.length).map((s) => ({ ...s, period_open: false }))} year={y} />
      <div className="toolbar">
        <label>Year <select value={y} onChange={(e) => setYear(Number(e.target.value))}>{(years.length ? years : [y]).map((x) => <option key={x}>{x}</option>)}</select></label>
        <label>Period <select value={month} onChange={(e) => setMonth(e.target.value)}><option value="YTD">Year to date</option>{MONTHS.map((m, i) => <option key={m} value={String(i + 1).padStart(2, '0')}>{m}</option>)}</select></label>
        <label>Department <select value={dept} onChange={(e) => setDept(e.target.value)}><option value="ALL">All</option>{data.byDept.map(([d]) => <option key={d} value={d}>{deptName(d)}</option>)}</select></label>
        <label>Entity <select value={entity} onChange={(e) => setEntity(e.target.value)}><option value="ALL">All</option>{ref.entities.map((e) => <option key={e.entity_id}>{e.entity_id}</option>)}</select></label>
      </div>
      {rows !== null && !rows.length && <Banner kind="info">Nothing imported for {y} yet. Ask Controller for the General Ledger export (accounts 4000-9999, posted only, accrual, CSV) and load it on the Imports page.</Banner>}
      <div className="two">
        <Card title="By department">
          <Scroll><table className="grid">
            <thead><tr><th>Department</th><th className="r">Revenue</th><th className="r">Costs</th><th className="r">Net</th></tr></thead>
            <tbody>
              {data.byDept.map(([d, v]) => (
                <tr key={d} className={d === '' ? 'nodept' : ''}><td>{d === '' ? 'No department (not plugged)' : deptName(d)}</td>
                  <td className="r num">{fmt(v.rev, 2)}</td><td className="r num">{fmt(v.cost, 2)}</td><td className={`r num ${neg(v.rev - v.cost)}`}>{fmt(v.rev - v.cost, 2)}</td></tr>
              ))}
              <tr className="total"><td>Consolidated total</td><td className="r num">{fmt(tot.rev, 2)}</td><td className="r num">{fmt(tot.cost, 2)}</td><td className={`r num ${neg(tot.rev - tot.cost)}`}>{fmt(tot.rev - tot.cost, 2)}</td></tr>
            </tbody>
          </table></Scroll>
        </Card>
        <Card title={`Accounts · ${dept === 'ALL' ? 'all departments' : deptName(dept)}`}>
          <Scroll><table className="grid">
            <thead><tr><th>Account</th><th>Sage section</th><th className="r">Amount</th></tr></thead>
            <tbody>
              {data.byAcct.map(([a, v]) => { const acc = ref.accounts.find((x) => x.account === a); return (
                <tr key={a}><td>{a} {acc?.name}</td><td className="muted">{acc?.pl_section ?? ''}</td><td className={`r num ${neg(v)}`}>{fmt(v, 2)}</td></tr>); })}
              <tr className="subtotal"><td colSpan={2}>Revenue</td><td className="r num">{fmt(acctRev, 2)}</td></tr>
              <tr className="subtotal"><td colSpan={2}>Costs</td><td className="r num">{fmt(acctCost, 2)}</td></tr>
              <tr className="total"><td colSpan={2}>Net income</td><td className={`r num ${neg(acctRev - acctCost)}`}>{fmt(acctRev - acctCost, 2)}</td></tr>
            </tbody>
          </table></Scroll>
        </Card>
      </div>
    </Page>
  );
}
