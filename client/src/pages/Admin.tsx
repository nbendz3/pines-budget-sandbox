import { useEffect, useState } from 'react';
import { api, useApp } from '../store';
import { Page, Card, Scroll, NumCell, TextCell, Seg, fmt } from '../ui';

export function ChangeLog() {
  const { scenarioId, ref } = useApp();
  const [scope, setScope] = useState<'ONE' | 'ALL'>('ONE');
  const [text, setText] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    const t = setTimeout(() => {
      const p = new URLSearchParams();
      if (scope === 'ONE' && scenarioId) p.set('scenario', String(scenarioId));
      if (text.trim()) p.set('q', text.trim());
      api<any>(`/audit?${p}`).then((r) => setRows(r.rows)).catch(() => {});
    }, 200);
    return () => clearTimeout(t);
  }, [scope, text, scenarioId]);
  const sname = (id: number | null) => (id ? ref.scenarios.find((s) => s.id === id)?.name ?? `#${id}` : '');
  return (
    <Page title="Change Log" sub="Every change to a driver, rate, typed amount, override, lever, statistic or cash row. Latest 500.">
      <div className="toolbar">
        <Seg value={scope} onChange={setScope} options={[['ONE', 'Open scenario'], ['ALL', 'Everything']]} />
        <label>Filter <input value={text} onChange={(e) => setText(e.target.value)} placeholder="who, field or line" /></label>
      </div>
      <Scroll><table className="grid">
        <thead><tr><th>When</th><th>Who</th><th>Scenario</th><th>What</th><th>Line / detail</th><th>Month</th><th className="r">Old</th><th className="r">New</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}><td>{new Date(r.at).toLocaleString()}</td><td>{r.who}</td><td className="muted">{sname(r.scenario_id)}</td><td>{r.field}</td><td>{r.detail}</td><td>{r.ym}</td>
              <td className="r num">{r.old_value}</td><td className="r num">{r.new_value}</td></tr>))}
          {!rows.length && <tr><td colSpan={8} className="muted">No changes recorded yet.</td></tr>}
        </tbody>
      </table></Scroll>
    </Page>
  );
}

export function Settings() {
  const { ref, run, deptName } = useApp();
  const [norms, setNorms] = useState<any[]>([]);
  const load = () => api<any>('/normalizations').then((r) => setNorms(r.rows)).catch(() => {});
  useEffect(() => { load(); }, []);
  const set = (k: string, v: string) => run(() => api('/settings', { method: 'PUT', body: { [k]: v } }), 'both');
  const patch = (id: number, body: any) => run(async () => { await api(`/normalizations/${id}`, { method: 'PATCH', body }); await load(); });
  const s = ref.settings;
  return (
    <Page title="Settings">
      <Card title="Resort">
        <div className="toolbar wrap">
          <label>Room count <NumCell className="boxed" value={Number(s.room_count)} onCommit={(v) => v && set('room_count', String(v))} /></label>
          <label>Fiscal year for new scenarios <NumCell className="boxed" value={Number(s.fiscal_year)} onCommit={(v) => v && set('fiscal_year', String(v))} /></label>
          <label>Default entity <select value={s.default_entity} onChange={(e) => set('default_entity', e.target.value)}>{ref.entities.map((e) => <option key={e.entity_id} value={e.entity_id}>{e.entity_id} {e.entity_name}</option>)}</select></label>
          <label>Rooms department <select value={s.rooms_dept} onChange={(e) => set('rooms_dept', e.target.value)}>{ref.departments.filter((d) => !d.is_rollup_group).map((d) => <option key={d.dept_id} value={d.dept_id}>{deptName(d.dept_id)}</option>)}</select></label>
          <label>Room revenue accounts <TextCell className="boxed" value={s.room_rev_accounts} onCommit={(v) => set('room_rev_accounts', v)} /></label>
        </div>
        <p className="muted small">Room revenue accounts are combined for ADR and occupancy what-ifs. Suites (4002) has been $0 since April 2026 because suites now book to Chalets (4001), so always keep both.</p>
      </Card>
      <Card title="Normalizations: one-time items in last year’s actuals">
        <p className="muted small">When a one-time item is switched on, its amount is taken out of last year’s base before “Growth over last year” lines grow it. Enter the amount as it was booked in that account (a negative number for a credit to a cost account). The four below came from the build kit with rounded amounts, so they start switched off until you confirm them.</p>
        <Scroll><table className="grid">
          <thead><tr><th>On</th><th>Label</th><th>Account</th><th>Department</th><th>Month</th><th className="r">Amount booked</th><th /></tr></thead>
          <tbody>
            {norms.map((n) => (
              <tr key={n.id} className={n.enabled ? '' : 'off'}>
                <td><input type="checkbox" checked={n.enabled} aria-label={`${n.label} on`} onChange={(e) => patch(n.id, { enabled: e.target.checked })} /></td>
                <td className="name wide"><TextCell value={n.label} onCommit={(v) => patch(n.id, { label: v })} /></td>
                <td><TextCell value={n.account} placeholder="account" onCommit={(v) => patch(n.id, { account: v.trim() })} /></td>
                <td><select value={n.dept_id ?? ''} onChange={(e) => patch(n.id, { dept_id: e.target.value || null })}><option value="">Any</option>{ref.departments.filter((d) => !d.is_rollup_group).map((d) => <option key={d.dept_id} value={d.dept_id}>{deptName(d.dept_id)}</option>)}</select></td>
                <td><TextCell value={n.ym} placeholder="2025-12" onCommit={(v) => /^\d{4}-\d{2}$/.test(v) && patch(n.id, { ym: v })} /></td>
                <td className="r"><NumCell value={n.amount} dec={2} onCommit={(v) => patch(n.id, { amount: v ?? 0 })} /></td>
                <td className="acts"><button className="link bad" onClick={() => run(async () => { await api(`/normalizations/${n.id}`, { method: 'DELETE' }); await load(); })}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table></Scroll>
        <button onClick={() => run(async () => { await api('/normalizations', { body: { label: 'One-time item', account: '', ym: `${Number(s.fiscal_year) - 1}-12`, amount: 0, enabled: false } }); await load(); })}>+ Add a one-time item</button>
      </Card>
      <Card title="Reference data">
        <p className="small">{ref.accounts.length} accounts · {ref.departments.length} departments · {ref.entities.length} entities · {fmt(ref.statReference.length)} history rows (HMS and Lightspeed).</p>
        <p className="muted small">The build kit expects 277 accounts and 41 departments once the real seed files are loaded.</p>
      </Card>
    </Page>
  );
}
