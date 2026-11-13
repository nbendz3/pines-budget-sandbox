import { useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, compute, useApp, type Bundle } from '../store';
import { Page, Card, Scroll, Banner, fmt, money, pct, neg } from '../ui';
import { C1, C2, C3, C4 } from './Dashboard';
import { MONTHS, sensitivity, sum, zeros } from '../../../shared/calc';

const METRICS: [string, string][] = [['total_rev', 'Revenue'], ['dept_profit', 'Departmental Profit'], ['gop', 'GOP'], ['ebitda', 'EBITDA'], ['net_income', 'Net Income']];
const COLORS = [C1, C2, C3, C4];

export function Compare() {
  const { ref, scenarioId, bundle } = useApp();
  const [ids, setIds] = useState<number[]>(() => {
    const others = ref.scenarios.filter((s) => s.id !== scenarioId).slice(-1).map((s) => s.id);
    return scenarioId ? [...others, scenarioId] : others;
  });
  const [loaded, setLoaded] = useState<Record<number, Bundle>>({});
  const [metric, setMetric] = useState('net_income');
  useEffect(() => {
    let live = true;
    Promise.all(ids.map((id) => api<Bundle>(`/scenarios/${id}/bundle`).then((b) => [id, b] as const)))
      .then((all) => { if (live) setLoaded(Object.fromEntries(all)); }).catch(() => {});
    return () => { live = false; };
  }, [ids, bundle]);
  const cols = useMemo(() => ids.filter((id) => loaded[id]).map((id) => ({ id, b: loaded[id], c: compute(loaded[id]) })), [ids, loaded]);
  const toggle = (id: number) => setIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= 4 ? cur : [...cur, id]));
  const first = cols[0];
  const value = (c: (typeof cols)[number], key: string) => (key === 'ending_cash' ? c.c.cash.rows.ending[11] : sum(c.c.summary[key]));
  const monthly = (c: (typeof cols)[number], key: string) => (key === 'ending_cash' ? c.c.cash.rows.ending : c.c.summary[key]);

  const changed = useMemo(() => {
    if (cols.length < 2) return [];
    const key = (l: any) => `${l.deptId}|${l.account}|${l.name}`;
    const base = new Map(first.b.lines.map((l) => [key(l), { l, t: sum(first.c.result.byLine[l.id] ?? zeros()) }]));
    const out: { label: string; scen: string; a: number; b: number }[] = [];
    for (const c of cols.slice(1)) {
      const seen = new Set<string>();
      for (const l of c.b.lines) {
        const k = key(l); seen.add(k);
        const t = sum(c.c.result.byLine[l.id] ?? zeros());
        const a = base.get(k)?.t ?? 0;
        if (Math.abs(t - a) > 5000) out.push({ label: `${l.sheet}: ${l.account} ${l.name}`, scen: c.b.scenario.name, a, b: t });
      }
      for (const [k, v] of base) if (!seen.has(k) && Math.abs(v.t) > 5000) out.push({ label: `${v.l.sheet}: ${v.l.account} ${v.l.name} (not in this scenario)`, scen: c.b.scenario.name, a: v.t, b: 0 });
    }
    return out.sort((x, y) => Math.abs(y.b - y.a) - Math.abs(x.b - x.a));
  }, [cols, first]);

  const chart = MONTHS.map((m, i) => Object.fromEntries([['month', m], ...cols.map((c) => [c.b.scenario.name, Math.round(c.c.summary.net_income[i])])]));
  return (
    <Page title="Compare" sub="Pick 2 to 4 scenarios. Differences are against the first one picked.">
      <Card>
        <div className="toolbar wrap">
          {ref.scenarios.map((s) => (
            <label key={s.id} className="check"><input type="checkbox" checked={ids.includes(s.id)} disabled={!ids.includes(s.id) && ids.length >= 4} onChange={() => toggle(s.id)} />
              {ids.indexOf(s.id) >= 0 && <span className="badge">{ids.indexOf(s.id) + 1}</span>} {s.name}</label>
          ))}
        </div>
      </Card>
      {cols.length < 2 && <Banner kind="info">Pick at least two scenarios. To make a second one, copy a scenario on the Scenarios page and change something.</Banner>}
      {cols.length >= 1 && (
        <Card title="Year">
          <Scroll><table className="grid">
            <thead><tr><th />{cols.map((c, i) => [<th key={c.id} className="r">{c.b.scenario.name}</th>, i > 0 && <th key={`${c.id}d`} className="r">vs first $</th>, i > 0 && <th key={`${c.id}p`} className="r grp">%</th>])}</tr></thead>
            <tbody>
              {[...METRICS, ['ending_cash', 'Ending cash (Dec)'] as [string, string]].map(([k, label]) => (
                <tr key={k} className={k === 'net_income' ? 'total' : ''}><td className="name">{label}</td>
                  {cols.map((c, i) => { const v = value(c, k); const d = v - value(first, k); return [
                    <td key={c.id} className={`r num ${neg(v)}`}>{fmt(v)}</td>,
                    i > 0 && <td key={`${c.id}d`} className={`r num ${neg(d)}`}>{fmt(d)}</td>,
                    i > 0 && <td key={`${c.id}p`} className={`r num grp ${neg(d)}`}>{value(first, k) ? pct((100 * d) / Math.abs(value(first, k))) : ''}</td>]; })}
                </tr>
              ))}
            </tbody>
          </table></Scroll>
        </Card>
      )}
      {cols.length >= 1 && (
        <Card title="By month">
          <div className="toolbar"><label>Show <select value={metric} onChange={(e) => setMetric(e.target.value)}>{[...METRICS, ['ending_cash', 'Ending cash']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label></div>
          <Scroll><table className="grid">
            <thead><tr><th>Scenario</th>{MONTHS.map((m) => <th key={m} className="r">{m}</th>)}<th className="r">Year</th></tr></thead>
            <tbody>
              {cols.map((c, i) => { const v = monthly(c, metric); const f = monthly(first, metric); return [
                <tr key={c.id}><td className="name">{c.b.scenario.name}</td>{v.map((x, m) => <td key={m} className={`r num ${neg(x)}`}>{fmt(x)}</td>)}<td className={`r num tot ${neg(value(c, metric))}`}>{fmt(value(c, metric))}</td></tr>,
                i > 0 && <tr key={`${c.id}d`} className="pctrow"><td className="name">  difference vs first</td>{v.map((x, m) => <td key={m} className={`r num ${neg(x - f[m])}`}>{fmt(x - f[m])}</td>)}<td className={`r num tot ${neg(value(c, metric) - value(first, metric))}`}>{fmt(value(c, metric) - value(first, metric))}</td></tr>]; })}
            </tbody>
          </table></Scroll>
          <div className="chart">
            <ResponsiveContainer>
              <BarChart data={chart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#e5e7eb" vertical={false} /><XAxis dataKey="month" tickLine={false} />
                <YAxis tickFormatter={(v) => `${Math.round(v / 1000)}k`} tickLine={false} axisLine={false} width={48} />
                <Tooltip formatter={(v: number) => money(v)} /><Legend /><ReferenceLine y={0} stroke="#94a3b8" />
                {cols.map((c, i) => <Bar key={c.id} dataKey={c.b.scenario.name} fill={COLORS[i]} radius={[2, 2, 0, 0]} />)}
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="muted small">Chart: net income by month for each scenario.</p>
        </Card>
      )}
      {cols.length >= 2 && (
        <Card title={`What changed: lines whose year total differs by more than $5,000 (${changed.length})`}>
          {changed.length === 0 ? <p className="muted">Nothing differs by more than $5,000.</p> : (
            <Scroll><table className="grid">
              <thead><tr><th>Line</th><th>Scenario</th><th className="r">{first.b.scenario.name}</th><th className="r">This scenario</th><th className="r">Difference</th></tr></thead>
              <tbody>{changed.slice(0, 200).map((r, i) => (
                <tr key={i}><td>{r.label}</td><td className="muted">{r.scen}</td><td className="r num">{fmt(r.a)}</td><td className="r num">{fmt(r.b)}</td><td className={`r num ${neg(r.b - r.a)}`}>{fmt(r.b - r.a)}</td></tr>))}</tbody>
            </table></Scroll>
          )}
        </Card>
      )}
      {bundle && <Sensitivity />}
    </Page>
  );
}

function Sensitivity() {
  const { bundle } = useApp();
  const b = bundle!;
  const s = useMemo(() => sensitivity(b.lines, b.stats, b.adjustments, b.options), [b]);
  const base = s.grid[2][2];
  return (
    <Card title={`Sensitivity: net income for “${b.scenario.name}”`}>
      <Scroll><table className="grid sens">
        <thead><tr><th>Occupancy ↓ / ADR →</th>{s.adrPct.map((a) => <th key={a} className="r">ADR {a > 0 ? '+' : ''}{a}%</th>)}</tr></thead>
        <tbody>{s.occPts.map((o, i) => (
          <tr key={o}><td className="name">Occupancy {o > 0 ? '+' : ''}{o} pts</td>
            {s.grid[i].map((v, j) => <td key={j} className={`r num ${neg(v)} ${i === 2 && j === 2 ? 'centre' : ''}`} title={`${money(v - base)} vs the scenario`}>{fmt(v)}</td>)}</tr>))}</tbody>
      </table></Scroll>
      <p className="muted small">Occupancy moves rooms sold (and with it CPOR wages and room revenue at the same ADR). ADR moves room revenue on accounts {b.options.roomRevAccounts.join(' + ')}. The centre cell is the scenario as it stands.</p>
    </Card>
  );
}
