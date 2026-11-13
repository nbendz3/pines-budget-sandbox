import { useMemo, useState } from 'react';
import { api, useApp } from '../store';
import { Page, Card, Scroll, Banner, NumCell, TextCell, money, neg } from '../ui';
import { MONTHS, computeScenario, summarizeScenario, leverMatchesLine, sum, type Adjustment } from '../../../shared/calc';

export function Scenarios() {
  const { ref, scenarioId, setScenarioId, run, bundle, locked } = useApp();
  const [name, setName] = useState('');
  const [copyFrom, setCopyFrom] = useState<string>('');
  const [kind, setKind] = useState('WHATIF');
  const create = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await api<{ id: number }>('/scenarios', { body: { name, copyFrom: copyFrom || (scenarioId ?? undefined), kind } });
      setName('');
      setScenarioId(r.id);
    }, 'ref');
  };
  const patch = (id: number, body: any) => run(() => api(`/scenarios/${id}`, { method: 'PATCH', body }), 'both');
  return (
    <Page title="Scenarios" sub="Copy a budget, change it, and compare. A copy carries every line, month, driver, lever and cash row.">
      <Card title="Create a scenario">
        <form className="toolbar" onSubmit={create}>
          <label>Name <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. 2027 - rent increase" size={28} /></label>
          <label>Copy of <select value={copyFrom || String(scenarioId ?? '')} onChange={(e) => setCopyFrom(e.target.value)}>
            {ref.scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label>Kind <select value={kind} onChange={(e) => setKind(e.target.value)}><option>BASE</option><option>BUDGET</option><option>WHATIF</option></select></label>
          <button className="primary">Create</button>
        </form>
      </Card>
      <Card title="All scenarios">
        <Scroll><table className="grid">
          <thead><tr><th>Name</th><th>Kind</th><th>Year</th><th>Parent</th><th>Status</th><th className="r">Lines</th><th>Created</th><th /></tr></thead>
          <tbody>
            {ref.scenarios.map((s) => {
              const isLocked = s.status === 'LOCKED';
              return (
                <tr key={s.id} className={s.id === scenarioId ? 'active' : ''}>
                  <td className="name wide"><TextCell value={s.name} disabled={isLocked} onCommit={(v) => v.trim() && patch(s.id, { name: v })} /></td>
                  <td><select value={s.kind} disabled={isLocked} onChange={(e) => patch(s.id, { kind: e.target.value })}><option>BASE</option><option>BUDGET</option><option>WHATIF</option></select></td>
                  <td>{s.fiscal_year}</td>
                  <td><select value={s.parent_id ?? ''} disabled={isLocked} onChange={(e) => patch(s.id, { parent_id: e.target.value ? Number(e.target.value) : null })}>
                    <option value="">—</option>{ref.scenarios.filter((o) => o.id !== s.id).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></td>
                  <td>{isLocked ? <span className="badge lock" title={`Locked by ${s.locked_by ?? ''} ${s.locked_at ? new Date(s.locked_at).toLocaleString() : ''}`}>LOCKED</span> : 'Draft'}</td>
                  <td className="r num">{s.line_count}</td>
                  <td>{new Date(s.created_at).toLocaleDateString()}</td>
                  <td className="acts">
                    {s.id !== scenarioId && <button className="link" onClick={() => setScenarioId(s.id)}>Open</button>}
                    <button className="link" title="Copy with today's date in the name, and lock the copy" onClick={() => run(() => api(`/scenarios/${s.id}/snapshot`, { method: 'POST' }), 'ref')}>Save a snapshot</button>
                    <button className="link" onClick={() => patch(s.id, { status: isLocked ? 'DRAFT' : 'LOCKED' })}>{isLocked ? 'Unlock' : 'Lock'}</button>
                    {!isLocked && ref.scenarios.length > 1 && <button className="link bad" onClick={() => window.confirm(`Delete "${s.name}"? This cannot be undone.`) && run(() => api(`/scenarios/${s.id}`, { method: 'DELETE' }), 'ref')}>Delete</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></Scroll>
      </Card>
      {bundle && locked && <Banner kind="info">“{bundle.scenario.name}” was locked by {bundle.scenario.locked_by || 'someone'}{bundle.scenario.locked_at ? ` on ${new Date(bundle.scenario.locked_at).toLocaleString()}` : ''}. Inputs are read-only. Unlock it, or create a copy above.</Banner>}
      {bundle && <Levers />}
    </Page>
  );
}

type Draft = Partial<Adjustment> & { label: string };
function Levers() {
  const { bundle, scenarioId, run, locked, ref, deptName } = useApp();
  const b = bundle!;
  const o = b.options;
  const presets: Draft[] = [
    { label: 'Rent +$30,000/mo from January', targetType: 'ACCOUNT', deptId: '95', account: '6900', appliesTo: 'COST', mode: 'ADD', value: 30000 },
    { label: 'Hourly wages +2.96% from January', targetType: 'ACCOUNT', account: '6003', appliesTo: 'COST', mode: 'PCT', value: 2.96 },
    { label: 'ADR +3%', targetType: 'ACCOUNT', deptId: o.roomsDept, account: o.roomRevAccounts.join(','), appliesTo: 'REVENUE', mode: 'PCT', value: 3 },
    { label: 'Occupancy +2 points', targetType: 'STAT', statKey: 'OCC_PTS', appliesTo: 'BOTH', mode: 'ADD', value: 2 },
    { label: 'Insurance +5%', targetType: 'ACCOUNT', account: '6300', appliesTo: 'COST', mode: 'PCT', value: 5 },
    { label: 'Food cost +2 points', targetType: 'ACCOUNT', account: '5184-5196', appliesTo: 'COST', mode: 'PTS_OF_REV', value: 2 },
    { label: 'New lever', targetType: 'ALL', appliesTo: 'COST', mode: 'PCT', value: 0 },
  ];
  const add = (d: Draft) => run(() => api(`/scenarios/${scenarioId}/adjustments`, { body: { fromMonth: 0, toMonth: 11, enabled: true, ...d } }));
  const patch = (id: number, body: Partial<Adjustment>) => run(() => api(`/adjustments/${id}`, { method: 'PATCH', body }));
  // what each lever adds to the year's net income, holding the others as they are
  const impact = useMemo(() => {
    const ni = (adj: Adjustment[]) => sum(summarizeScenario(b.lines, computeScenario(b.lines, b.stats, adj, b.options).byLine).net_income);
    const withAll = ni(b.adjustments);
    const base = ni([]);
    return { base, withAll, each: Object.fromEntries(b.adjustments.map((a) => [a.id, a.enabled ? withAll - ni(b.adjustments.filter((x) => x.id !== a.id)) : 0])) };
  }, [b]);
  return (
    <Card title={`What-if levers on “${b.scenario.name}”`}>
      <p className="muted small">Levers sit on top of the drivers and can be switched on and off. A lever on wages also moves overtime, PTO and payroll taxes, because they are a % of wages.</p>
      <div className="toolbar">{presets.map((p) => <button key={p.label} disabled={locked} onClick={() => add(p)}>+ {p.label}</button>)}</div>
      {b.adjustments.length > 0 && (
        <Scroll><table className="grid levers">
          <thead><tr><th>On</th><th>Label</th><th>Target</th><th>Department</th><th>Account(s)</th><th>Applies to</th><th>Type</th><th className="r">Value</th><th>From</th><th>To</th><th className="r">Lines hit</th><th className="r">Net income effect</th><th /></tr></thead>
          <tbody>
            {b.adjustments.map((a) => {
              const stat = a.targetType === 'STAT';
              const hits = stat ? null : b.lines.filter((l) => leverMatchesLine(a, l)).length;
              return (
                <tr key={a.id} className={a.enabled ? '' : 'off'}>
                  <td><input type="checkbox" aria-label={`${a.label} on`} checked={a.enabled} disabled={locked} onChange={(e) => patch(a.id, { enabled: e.target.checked })} /></td>
                  <td className="name wide"><TextCell value={a.label} disabled={locked} onCommit={(v) => patch(a.id, { label: v })} /></td>
                  <td><select value={a.targetType} disabled={locked} onChange={(e) => patch(a.id, { targetType: e.target.value as any, statKey: e.target.value === 'STAT' ? 'OCC_PTS' : null, mode: e.target.value === 'STAT' ? 'ADD' : a.mode === 'ADD' && stat ? 'PCT' : a.mode })}>
                    <option value="ALL">Whole resort</option><option value="DEPT">A department</option><option value="ACCOUNT">An account</option><option value="LINE">A single line</option><option value="STAT">A statistic</option></select></td>
                  <td>{stat ? (
                    <select value={a.statKey ?? 'OCC_PTS'} disabled={locked} onChange={(e) => patch(a.id, { statKey: e.target.value as any })}>
                      <option value="OCC_PTS">Occupancy (points)</option><option value="ROOMS_SOLD">Rooms sold (%)</option><option value="COVERS">Covers (%)</option></select>
                  ) : a.targetType === 'LINE' ? (
                    <select value={a.lineId ?? ''} disabled={locked} onChange={(e) => patch(a.id, { lineId: Number(e.target.value) })}>
                      <option value="">pick a line</option>{b.lines.map((l) => <option key={l.id} value={l.id}>{l.sheet}: {l.account} {l.name}</option>)}</select>
                  ) : a.targetType === 'ALL' ? '' : (
                    <select value={a.deptId ?? ''} disabled={locked} onChange={(e) => patch(a.id, { deptId: e.target.value || null })}>
                      <option value="">{a.targetType === 'ACCOUNT' ? 'All departments' : 'pick one'}</option>{ref.departments.filter((d) => !d.is_rollup_group).map((d) => <option key={d.dept_id} value={d.dept_id}>{deptName(d.dept_id)}</option>)}</select>
                  )}</td>
                  <td>{a.targetType === 'ACCOUNT' && <TextCell value={a.account ?? ''} disabled={locked} placeholder="6003 or 5184-5196" onCommit={(v) => patch(a.id, { account: v })} />}</td>
                  <td>{!stat && <select value={a.appliesTo} disabled={locked} onChange={(e) => patch(a.id, { appliesTo: e.target.value as any })}><option value="REVENUE">Revenue</option><option value="COST">Costs</option><option value="BOTH">Both</option></select>}</td>
                  <td>{stat ? (a.statKey === 'OCC_PTS' ? 'Add points' : 'Percent change') : (
                    <select value={a.mode} disabled={locked} onChange={(e) => patch(a.id, { mode: e.target.value as any })}>
                      <option value="PCT">Percent change</option><option value="ADD">Add $ per month</option><option value="SET">Set $ per month</option><option value="PTS_OF_REV">Add points of revenue</option></select>)}</td>
                  <td className="r"><NumCell value={a.value} dec={2} disabled={locked} onCommit={(v) => patch(a.id, { value: v ?? 0 })} /></td>
                  <td><select value={a.fromMonth} disabled={locked} onChange={(e) => patch(a.id, { fromMonth: Number(e.target.value) })}>{MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}</select></td>
                  <td><select value={a.toMonth} disabled={locked} onChange={(e) => patch(a.id, { toMonth: Number(e.target.value) })}>{MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}</select></td>
                  <td className={`r num ${hits === 0 ? 'neg' : ''}`} title={hits === 0 ? 'This lever matches no budget line, so it changes nothing' : ''}>{hits ?? '—'}</td>
                  <td className={`r num ${neg(impact.each[a.id])}`}>{a.enabled ? money(impact.each[a.id]) : 'off'}</td>
                  <td className="acts"><button className="link bad" disabled={locked} onClick={() => run(() => api(`/adjustments/${a.id}`, { method: 'DELETE' }))}>Remove</button></td>
                </tr>
              );
            })}
          </tbody>
        </table></Scroll>
      )}
      <p className="small">Net income without levers <strong>{money(impact.base)}</strong> · with the levers that are on <strong className={neg(impact.withAll)}>{money(impact.withAll)}</strong> · difference <strong className={neg(impact.withAll - impact.base)}>{money(impact.withAll - impact.base)}</strong></p>
    </Card>
  );
}
