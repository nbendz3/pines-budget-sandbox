import { useMemo, useState } from 'react';
import { api, useApp } from '../store';
import { Page, NumCell, TextCell, Scroll, Banner, fmt, pct, neg } from '../ui';
import { DRIVER_LABELS, DERIVED_DRIVERS, PCT_DRIVERS, STAT_DRIVERS, MONTHS, sum, zeros, add12, spreadByShape, type DriverType, type Line, type Num12 } from '../../../shared/calc';

const DRIVERS = Object.keys(DRIVER_LABELS) as DriverType[];
const RATE_HINT: Partial<Record<DriverType, string>> = {
  PCT_REVENUE: '% of the department revenue', PCT_WAGES: '% of staff wages', PER_OCC_ROOM: '$ per occupied room', PER_COVER: '$ per cover',
  GROWTH_OVER_PY: '% growth over the same month last year', ROOMS_X_ADR: 'share of rooms sold x ADR (1 = all)', COVERS_X_CHECK: 'share of covers x check (1 = all)',
  FIXED: 'optional: same $ every month',
};

export function Budget() {
  const { bundle, result, locked, setCells, patchLine, run, ref, deptName, toast } = useApp();
  const sheets = useMemo(() => [...new Set(bundle?.lines.map((l) => l.sheet) ?? [])], [bundle]);
  const [tab, setTab] = useState<string>('');
  const [overrideMode, setOverrideMode] = useState(false);
  const [adding, setAdding] = useState(false);
  if (!bundle || !result) return <Page title="Budget"><p className="muted">Pick or create a scenario first.</p></Page>;
  const sheet = sheets.includes(tab) ? tab : sheets[0];
  const lines = bundle.lines.filter((l) => l.sheet === sheet);
  const deptId = lines[0]?.deptId;
  const vals = (l: Line) => result.byLine[l.id] ?? zeros();
  const total = (ls: Line[]) => ls.reduce((t, l) => add12(t, vals(l)), zeros());
  const rev = lines.filter((l) => l.kind === 'REVENUE');
  const payroll = lines.filter((l) => l.kind === 'COST' && l.isPayroll);
  const other = lines.filter((l) => l.kind === 'COST' && !l.isPayroll);
  const tRev = total(rev); const tPay = total(payroll); const tOth = total(other);
  const tExp = add12(tPay, tOth);
  const profit = tRev.map((v, m) => v - tExp[m]);
  const occ = deptId === bundle.options.roomsDept ? result.stats.roomsSold : result.stats.occRooms[deptId];
  const covers = result.stats.covers[deptId];

  const editCell = (l: Line, m: number, v: number | null) => {
    const derived = DERIVED_DRIVERS.includes(l.driverType);
    setCells([{ lineId: l.id, month: m, field: derived ? 'override' : 'typed', value: v }]);
  };
  const copyLY = (l: Line) => {
    if (!l.py || !l.py.some((v) => v)) return toast('No actuals loaded for this line last year.', true);
    setCells(l.py.map((v, m) => ({ lineId: l.id, month: m, field: 'typed' as const, value: v ?? 0 })));
  };
  const spread = (l: Line) => {
    const t = window.prompt(`Yearly total for "${l.name}"? It will be spread by last year's monthly shape.`);
    if (!t) return;
    const n = Number(t.replace(/[$,\s]/g, ''));
    if (!Number.isFinite(n)) return;
    const shape = l.py?.some((v) => v) ? l.py : ref.statReference.filter((r) => r.key === 'room_revenue_hms' && r.ym.startsWith(`${bundle.scenario.fiscal_year - 2}`)).map((r) => r.value);
    const out = spreadByShape(n, shape && shape.length === 12 ? shape : new Array(12).fill(1));
    setCells(out.map((v, m) => ({ lineId: l.id, month: m, field: 'typed' as const, value: Math.round(v * 100) / 100 })));
  };

  const row = (l: Line) => {
    const v = vals(l);
    const derived = DERIVED_DRIVERS.includes(l.driverType);
    const stat = STAT_DRIVERS.includes(l.driverType);
    const canEdit = !locked && (!derived || overrideMode);
    return (
      <tr key={l.id}>
        <td className="mono">{l.account}</td>
        <td className="name">
          <div className="namewrap">
            <TextCell value={l.name} disabled={locked} onCommit={(name) => patchLine(l.id, { name })} />
            {l.isWageBase && <span className="badge" title="Staff wages: the base for % of Wages lines">wage base</span>}
            {stat && <span className="badge stat" title="Driven by a statistic on the Drivers page">stat</span>}
            {l.isCustom && <span className="badge add">added</span>}
          </div>
        </td>
        <td>
          <select value={l.driverType} disabled={locked} aria-label="Driver" onChange={(e) => patchLine(l.id, { driverType: e.target.value as DriverType })}>
            {DRIVERS.map((d) => <option key={d} value={d}>{DRIVER_LABELS[d]}</option>)}
          </select>
        </td>
        <td className="r rate">
          {l.driverType === 'FTE_HOURS' ? (
            <span className="fte" title="FTE count x hours per month x hourly rate">
              <NumCell value={l.fteCount} dec={1} disabled={locked} placeholder="FTE" onCommit={(x) => patchLine(l.id, { fteCount: x })} />
              <NumCell value={l.fteHours} dec={0} disabled={locked} placeholder="hrs" onCommit={(x) => patchLine(l.id, { fteHours: x })} />
              <NumCell value={l.fteRate} dec={2} disabled={locked} placeholder="$/hr" onCommit={(x) => patchLine(l.id, { fteRate: x })} />
            </span>
          ) : l.driverType === 'TYPED' ? <span className="muted">—</span> : (
            <NumCell value={l.driverInput} dec={PCT_DRIVERS.includes(l.driverType) ? 2 : 4} asPct={PCT_DRIVERS.includes(l.driverType)} disabled={locked}
              title={RATE_HINT[l.driverType]} onCommit={(x) => patchLine(l.id, { driverInput: x })} />
          )}
        </td>
        {v.map((x, m) => {
          const ov = l.override[m] !== null && l.override[m] !== undefined;
          const moved = !ov && !derived && l.typed[m] !== null && Math.abs(x - (l.typed[m] ?? 0)) > 0.005;
          return (
            <td key={m} className={`r ${ov ? 'ov' : derived ? 'drv' : moved ? 'lev' : ''}`}>
              <NumCell value={!derived && !ov && l.typed[m] === null && !x ? null : x} editValue={ov ? l.override[m] : derived ? x : l.typed[m]} disabled={!canEdit}
                title={ov ? 'Manual override (clear the cell to go back to the driver)' : moved ? `You typed ${fmt(l.typed[m])}. A lever that is switched on moves it to ${fmt(x)}.` : undefined} label={`${l.name} ${MONTHS[m]}`}
                onCommit={(nv) => editCell(l, m, nv)} />
            </td>
          );
        })}
        <td className={`r num tot ${neg(sum(v))}`}>{fmt(sum(v))}</td>
        <td className="acts">
          {!locked && l.kind === 'REVENUE' && l.driverType === 'TYPED' && <button className="link" title="Copy last year's actuals into every month" onClick={() => copyLY(l)}>LY</button>}
          {!locked && !derived && <button className="link" title="Spread a yearly total by last year's shape" onClick={() => spread(l)}>Spread</button>}
          {!locked && l.isCustom && <button className="link bad" title="Delete this added line" onClick={() => window.confirm(`Delete "${l.name}"?`) && run(() => api(`/lines/${l.id}`, { method: 'DELETE' }))}>Delete</button>}
        </td>
      </tr>
    );
  };
  const totalRow = (label: string, v: Num12, cls = 'total', showPct = true) => (
    <>
      <tr className={cls}>
        <td /><td colSpan={3}>{label}</td>
        {v.map((x, m) => <td key={m} className={`r num ${neg(x)}`}>{fmt(x)}</td>)}
        <td className={`r num tot ${neg(sum(v))}`}>{fmt(sum(v))}</td><td />
      </tr>
      {showPct && sum(tRev) !== 0 && label !== 'Total Revenue' && (
        <tr className="pctrow">
          <td /><td colSpan={3}>{label === 'Departmental Profit' ? 'Margin %' : '% of revenue'}</td>
          {v.map((x, m) => <td key={m} className="r num">{tRev[m] ? pct((100 * x) / tRev[m]) : ''}</td>)}
          <td className="r num tot">{pct((100 * sum(v)) / sum(tRev))}</td><td />
        </tr>
      )}
    </>
  );
  const statRow = (label: string, v: Num12 | undefined) => v && (
    <tr className="statrow"><td /><td colSpan={3}>{label} <span className="muted">(from Drivers)</span></td>
      {v.map((x, m) => <td key={m} className="r num">{fmt(x, 1)}</td>)}<td className="r num tot">{fmt(sum(v), 1)}</td><td /></tr>
  );

  return (
    <Page title="Budget" sub={`${sheets.length} department tabs · ${bundle.lines.length} lines · ${deptName(deptId)}`}
      actions={<>
        <label className="check" title="Lets you type over lines that are calculated from a driver or a statistic"><input type="checkbox" checked={overrideMode} disabled={locked} onChange={(e) => setOverrideMode(e.target.checked)} /> Override driver lines</label>
        <button disabled={locked} onClick={() => setAdding(!adding)}>+ Add line</button>
      </>}>
      {locked && <Banner kind="info">This scenario is locked by {bundle.scenario.locked_by || 'someone'}. Unlock it, or save it as a new scenario, on the Scenarios page.</Banner>}
      <div className="tabs" role="tablist">
        {sheets.map((s) => <button key={s} role="tab" aria-selected={s === sheet} className={s === sheet ? 'on' : ''} onClick={() => setTab(s)}>{s}</button>)}
      </div>
      {adding && <AddLine sheet={sheet} deptId={deptId} onDone={() => setAdding(false)} />}
      <Scroll>
        <table className="grid">
          <thead>
            <tr><th>Acct</th><th>Line</th><th>Driver</th><th className="r">Rate</th>{MONTHS.map((m) => <th key={m} className="r">{m}</th>)}<th className="r">Total</th><th /></tr>
          </thead>
          <tbody>
            {lines.some((l) => l.driverType === 'PER_OCC_ROOM') && statRow('Occupied rooms', occ)}
            {lines.some((l) => l.driverType === 'PER_COVER' || l.driverType === 'COVERS_X_CHECK') && statRow('Covers served', covers)}
            {rev.length > 0 && <tr className="section"><td colSpan={18}>Revenue</td></tr>}
            {rev.map(row)}
            {rev.length > 0 && totalRow('Total Revenue', tRev)}
            {payroll.length > 0 && <tr className="section"><td colSpan={18}>Payroll</td></tr>}
            {payroll.map(row)}
            {payroll.length > 0 && totalRow('Total Payroll', tPay, 'subtotal')}
            {other.length > 0 && <tr className="section"><td colSpan={18}>Non-payroll</td></tr>}
            {other.map(row)}
            {other.length > 0 && payroll.length > 0 && totalRow('Total Non-payroll', tOth, 'subtotal')}
            {totalRow('Total Expenses', tExp)}
            {totalRow('Departmental Profit', profit)}
          </tbody>
        </table>
      </Scroll>
      <p className="muted small">
        Type 1200, 1.2k or (500). Grey italic months come from the driver; orange months are manual overrides that win over the driver; a dotted underline means a lever moved what you typed.
        Percent rates are typed as percents (0.9 means 0.9%).
      </p>
    </Page>
  );
}

function AddLine({ sheet, deptId, onDone }: { sheet: string; deptId: string; onDone: () => void }) {
  const { ref, scenarioId, run } = useApp();
  const [account, setAccount] = useState('');
  const [name, setName] = useState('');
  const [driverType, setDriver] = useState<DriverType>('FIXED');
  const [rate, setRate] = useState('');
  const acct = ref.accounts.find((a) => a.account === account.split(' ')[0]);
  const isPct = PCT_DRIVERS.includes(driverType);
  return (
    <form className="card inline-form" onSubmit={(e) => {
      e.preventDefault();
      if (!acct) return;
      const n = rate === '' ? null : Number(rate) / (isPct ? 100 : 1);
      const existing = ref.departments.find((d) => d.dept_id === deptId);
      run(() => api(`/scenarios/${scenarioId}/lines`, { body: { deptId, sheet, account: acct.account, name: name || acct.name, driverType, driverInput: n,
        summaryRow: existing?.bucket ?? '', isWageBase: false } })).then(onDone);
    }}>
      <strong>Add a line to {sheet}</strong>
      <label>Account
        <input list="accts" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="number or name" required />
        <datalist id="accts">{ref.accounts.map((a) => <option key={a.account} value={`${a.account} ${a.name}`} />)}</datalist>
      </label>
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder={acct?.name ?? 'line name'} /></label>
      <label>Driver
        <select value={driverType} onChange={(e) => setDriver(e.target.value as DriverType)}>{DRIVERS.map((d) => <option key={d} value={d}>{DRIVER_LABELS[d]}</option>)}</select>
      </label>
      <label>Rate{isPct ? ' (%)' : ''}<input value={rate} onChange={(e) => setRate(e.target.value)} inputMode="decimal" placeholder={RATE_HINT[driverType] ?? ''} /></label>
      <button className="primary" disabled={!acct}>Add</button>
      <button type="button" onClick={onDone}>Cancel</button>
    </form>
  );
}
