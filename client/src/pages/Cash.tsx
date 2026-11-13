import { useRef } from 'react';
import { CartesianGrid, Line as RLine, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, useApp } from '../store';
import { Page, Card, Scroll, Banner, NumCell, TextCell, fmt, money, neg } from '../ui';
import { C1 } from './Dashboard';
import { CASH_ROWS, MONTHS, sum } from '../../../shared/calc';

const SECTION: Record<string, string> = { operating: 'Operating', investing: 'Investing', financing: 'Financing' };

export function Cash() {
  const { bundle, cash, locked, setCash, setCashNote, scenarioId, run, toast } = useApp();
  const file = useRef<HTMLInputElement>(null);
  if (!bundle || !cash) return <Page title="Cash Flow"><p className="muted">Pick or create a scenario first.</p></Page>;
  const low = cash.lowestMonth;
  const data = MONTHS.map((m, i) => ({ month: m, 'Ending cash': Math.round(cash.rows.ending[i]) }));
  const importCsv = async (f: File) => {
    const form = new FormData();
    form.append('file', f);
    await run(async () => {
      const r = await api<any>(`/scenarios/${scenarioId}/cash/import`, { form });
      toast(`${r.imported} cash rows loaded${r.skipped.length ? `, ${r.skipped.length} skipped (wrong year or unknown item_key)` : ''}.`, r.skipped.length > 0);
    });
  };
  let lastSection = '';
  return (
    <Page title="Cash Flow" sub="Money in is positive, money out is negative. EBITDA and interest come from the scenario; everything else is typed."
      actions={<>
        <input ref={file} type="file" accept=".csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importCsv(f); e.target.value = ''; }} />
        <button disabled={locked} title="CSV columns: scenario, ym, item_key, amount" onClick={() => file.current?.click()}>Import cash CSV</button>
      </>}>
      <Banner kind={cash.rows.ending[low] < 0 ? 'bad' : 'info'}>
        <strong>Lowest month-end cash: {MONTHS[low]}, {money(cash.rows.ending[low])}.</strong>
        {cash.rows.ending[low] < 0 && ' Cash goes below zero.'} Check: ending = opening + all movements {cash.check === 0 ? '✓' : `is off by ${money(cash.check, 2)}`}.
      </Banner>
      <Card>
        <div className="toolbar">
          <label>Opening cash on January 1 <NumCell value={bundle.cash.opening_balance?.[0] ?? null} disabled={locked} className="boxed" placeholder="type the balance" onCommit={(v) => setCash('opening_balance', 0, v)} /></label>
        </div>
        <Scroll><table className="grid cash">
          <thead><tr><th>Row</th>{MONTHS.map((m) => <th key={m} className="r">{m}</th>)}<th className="r">Year</th><th>Note</th></tr></thead>
          <tbody>
            {CASH_ROWS.map((r) => {
              const v = cash.rows[r.key];
              const head = SECTION[r.section] && SECTION[r.section] !== lastSection ? SECTION[r.section] : '';
              if (head) lastSection = head;
              const total = r.key === 'opening' ? v[0] : r.key === 'ending' ? v[11] : sum(v);
              return [
                head && <tr className="section" key={`${r.key}h`}><td colSpan={15}>{head}</td></tr>,
                <tr key={r.key} className={r.section === 'total' || r.section === 'open' ? 'total' : r.computed ? 'ro' : ''}>
                  <td className="name">{r.label}</td>
                  {v.map((x, m) => (
                    <td key={m} className={`r ${r.key === 'ending' && m === low ? 'lowcell' : ''}`}>
                      {r.computed ? <span className={`num ${neg(x)}`}>{fmt(x)}</span>
                        : <NumCell value={bundle.cash[r.key]?.[m] ?? null} disabled={locked} label={`${r.label} ${MONTHS[m]}`} onCommit={(nv) => setCash(r.key, m, nv)} />}
                    </td>
                  ))}
                  <td className={`r num tot ${neg(total)}`}>{fmt(total)}</td>
                  <td className="note"><TextCell value={bundle.cashNotes[r.key] ?? ''} disabled={locked} placeholder={r.computed ? '' : 'e.g. unconfirmed placeholder'} onCommit={(n) => setCashNote(r.key, n)} /></td>
                </tr>,
              ];
            })}
          </tbody>
        </table></Scroll>
        <p className="muted small">Still open from the 2027 draft: insurance renewals, loan schedule, 2027 capex, reserve deposit, rental homes. Put a placeholder in and mark it “unconfirmed” in the note.</p>
      </Card>
      <Card title="Ending cash by month">
        <div className="chart">
          <ResponsiveContainer>
            <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#e5e7eb" vertical={false} /><XAxis dataKey="month" tickLine={false} />
              <YAxis tickFormatter={(v) => `${Math.round(v / 1000)}k`} tickLine={false} axisLine={false} width={56} />
              <Tooltip formatter={(v: number) => money(v)} /><ReferenceLine y={0} stroke="#94a3b8" />
              <RLine dataKey="Ending cash" stroke={C1} strokeWidth={2.5} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>
    </Page>
  );
}
