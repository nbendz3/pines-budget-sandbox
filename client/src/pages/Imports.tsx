import { useEffect, useState } from 'react';
import { api, useApp } from '../store';
import { Page, Card, Scroll, Banner, fmt, neg, SAGE_OPEN } from '../ui';
import { clearActualsCache } from '../actuals';
import { MONTHS } from '../../../shared/calc';

const ymLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

function TieTable({ rows }: { rows: any[] }) {
  if (!rows.length) return null;
  return (
    <Scroll><table className="grid">
      <thead><tr><th>Month</th><th className="r">Expected revenue</th><th className="r">Imported</th><th className="r">Difference</th><th className="r">Expected net income</th><th className="r">Imported</th><th className="r">Difference</th><th>Result</th></tr></thead>
      <tbody>{rows.map((t) => (
        <tr key={t.ym}><td>{ymLabel(t.ym)}</td>
          <td className="r num">{fmt(t.expectedRevenue, 2)}</td><td className="r num">{fmt(t.revenue, 2)}</td><td className={`r num ${neg(t.diffRevenue)}`}>{fmt(t.diffRevenue, 2)}</td>
          <td className="r num">{fmt(t.expectedNetIncome, 2)}</td><td className="r num">{fmt(t.netIncome, 2)}</td><td className={`r num ${neg(t.diffNetIncome)}`}>{fmt(t.diffNetIncome, 2)}</td>
          <td>{!t.found ? <span className="pill bad">month not in file</span> : t.ok ? <span className="pill ok">✓ ties to the cent</span> : <span className="pill bad">✗ does not tie</span>}</td></tr>))}</tbody>
    </table></Scroll>
  );
}

function GLImport({ onSaved }: { onSaved: () => void }) {
  const { toast, reloadRef, reloadBundle } = useApp();
  const [pv, setPv] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState('');
  const [expected, setExpected] = useState('');
  const [tie, setTie] = useState<any[]>([]);
  const upload = async (f: File) => {
    setBusy(true); setPv(null); setTie([]);
    try { const form = new FormData(); form.append('file', f); setPv(await api('/import/gl/preview', { form })); } catch (e: any) { toast(e.message, true); }
    setBusy(false);
  };
  useEffect(() => {
    if (!pv || !expected.trim()) { setTie([]); return; }
    const t = setTimeout(() => api<any>('/import/gl/tieout', { body: { token: pv.token, expected } }).then((r) => setTie(r.tieout)).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [expected, pv]);
  const save = async (addUnknown: boolean) => {
    try {
      await api('/import/gl/commit', { body: { token: pv.token, sageCreatedOn: created, expected, addUnknown } });
      clearActualsCache(); setPv(null); setExpected(''); setCreated(''); setTie([]);
      toast('Actuals saved.'); await reloadRef(); await reloadBundle(); onSaved();
    } catch (e: any) { toast(e.message, true); }
  };
  const unknown = pv && !pv.ok && pv.lineCount > 0;
  return (
    <Card title="Sage General Ledger export (CSV)">
      <p className="muted small">Ask Controller for the General Ledger report: accounts 4000-9999, posted only, accrual, all locations, saved as CSV. Nothing in this app signs in to Sage; it only reads the file you upload.</p>
      <input type="file" accept=".csv,text/csv" aria-label="Sage GL CSV" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
      {busy && <p className="muted">Reading the file…</p>}
      {pv && (
        <div className="stack">
          <Banner kind="warn"><strong>{SAGE_OPEN}.</strong></Banner>
          <p><strong>{pv.fileName}</strong>: {fmt(pv.lineCount)} ledger lines, {fmt(pv.rowCount)} rows after summing by entity / department / account / month.</p>
          {pv.problems.map((p: string) => <Banner kind="bad" key={p}>{p}</Banner>)}
          {unknown && (
            <Banner kind="bad">
              <strong>This file cannot be saved yet.</strong> It uses codes the app does not know.
              {pv.unknownAccounts.length > 0 && <div>Unknown accounts: {pv.unknownAccounts.join(', ')}</div>}
              {pv.unknownDepts.length > 0 && <div>Unknown departments: {pv.unknownDepts.join(', ')}</div>}
              {pv.unknownEntities.length > 0 && <div>Unknown entities: {pv.unknownEntities.join(', ')}</div>}
              <div className="small">Fix: put the full chart_of_accounts.csv and departments.csv in /seed and press “Reload seed files” below, then upload again.</div>
            </Banner>
          )}
          <Scroll><table className="grid">
            <thead><tr><th>Month</th><th className="r">Lines</th><th className="r">Revenue</th><th className="r">Costs</th><th className="r">Net income</th><th className="r">No-department net</th></tr></thead>
            <tbody>{pv.months.map((m: any) => (
              <tr key={m.ym}><td>{ymLabel(m.ym)}</td><td className="r num">{fmt(m.lines)}</td><td className="r num">{fmt(m.revenue, 2)}</td><td className="r num">{fmt(m.cost, 2)}</td>
                <td className={`r num ${neg(m.netIncome)}`}>{fmt(m.netIncome, 2)}</td><td className={`r num ${neg(m.noDept)}`}>{fmt(m.noDept, 2)}</td></tr>))}</tbody>
          </table></Scroll>
          <label className="block">Tie-out: paste the totals Sage shows, one month per line as <code>month, revenue, net income</code>
            <textarea rows={3} value={expected} onChange={(e) => setExpected(e.target.value)} placeholder={'2026-10, 1390209.21, 34473.19'} />
          </label>
          <TieTable rows={tie} />
          <label className="block">Sage “Created on” time printed on the report (required)
            <input value={created} onChange={(e) => setCreated(e.target.value)} placeholder="e.g. 11/12/2026 1:07 PM PT" />
          </label>
          <div className="row gap">
            <button className="primary" disabled={!created.trim() || !pv.ok} onClick={() => save(false)}>Save these actuals</button>
            {unknown && <button disabled={!created.trim()} title="Adds the unknown codes as new accounts / departments with placeholder names, then saves" onClick={() => window.confirm('Add the unknown codes as new accounts and departments, then save? Their names and Sage sections will be placeholders until the real seed files are loaded.') && save(true)}>Add the unknown codes and save anyway</button>}
            <button onClick={() => setPv(null)}>Cancel</button>
          </div>
        </div>
      )}
    </Card>
  );
}

function WorkbookImport() {
  const { toast, reloadRef, setScenarioId } = useApp();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [fy, setFy] = useState('');
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<any>(null);
  const go = async () => {
    if (!file) return;
    setBusy(true); setOut(null);
    try {
      const form = new FormData();
      form.append('file', file); if (name) form.append('name', name); if (fy) form.append('fiscalYear', fy);
      const r = await api<any>('/import/workbook', { form });
      setOut(r); await reloadRef(); setScenarioId(r.scenarioId);
    } catch (e: any) { toast(e.message, true); }
    setBusy(false);
  };
  return (
    <Card title="Budget workbook (.xlsx)">
      <p className="muted small">Accepts 2026_Budget_from_Nick.xlsx or 2027_Budget_DRAFT_v3.xlsx. The department comes from the tab name, never the code prefix. Saved values are read, not formulas, so open the file in Excel and save it first if it was never recalculated.</p>
      <div className="toolbar">
        <input type="file" accept=".xlsx" aria-label="Budget workbook" onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); const y = f?.name.match(/20\d\d/)?.[0]; if (y) setFy(y); }} />
        <label>Scenario name <input value={name} onChange={(e) => setName(e.target.value)} placeholder="optional" /></label>
        <label>Fiscal year <input value={fy} onChange={(e) => setFy(e.target.value)} size={5} inputMode="numeric" /></label>
        <button className="primary" disabled={!file || busy} onClick={go}>{busy ? 'Importing…' : 'Import as a new scenario'}</button>
      </div>
      {out && (
        <div className="stack">
          <Banner kind="ok">Created a scenario with {out.lineCount} lines from {out.tabs} tabs (fiscal year {out.fiscalYear}). It is now the open scenario.</Banner>
          {out.staleCells > 0 && <Banner kind="bad">{out.staleCells} month cells had a formula but no saved value. Open the workbook in Excel, save it, and import again.</Banner>}
          {out.unknownTabs.length > 0 && <Banner kind="warn">Tabs not recognised and skipped: {out.unknownTabs.join(', ')}</Banner>}
          {out.unknownAccounts.length > 0 && <Banner kind="warn">Lines whose account is not in the chart of accounts: {out.unknownAccounts.join('; ')}</Banner>}
          {out.mismatches.length > 0 && <Banner kind="warn">{out.mismatches.length} driver lines did not recalculate to the workbook’s numbers, so the workbook’s {out.overrideCells} month values were kept as overrides (orange cells): {out.mismatches.slice(0, 12).join('; ')}{out.mismatches.length > 12 ? '…' : ''}</Banner>}
          {!out.summaryFound && <Banner kind="warn">No “Summary P&amp;L” tab found, so there is nothing to tie out against.</Banner>}
          {out.tie.map((t: any) => (
            <Banner key={t.row} kind={t.ok ? 'ok' : 'bad'}>
              <strong>{t.row === 'total_rev' ? 'Total Operating Revenue' : t.row === 'net_income' ? 'Net Income' : 'EBITDA'}:</strong> app {fmt(t.appTotal)} vs file {fmt(t.fileTotal)}.
              {t.ok ? ' ✓ Every month within $1.' : ` ✗ Months off: ${t.diffs.map((d: number, m: number) => (Math.abs(d) > 1 ? `${MONTHS[m]} ${fmt(d, 2)}` : '')).filter(Boolean).join(', ')}`}
            </Banner>
          ))}
        </div>
      )}
    </Card>
  );
}

export function Imports() {
  const { run, toast } = useApp();
  const [batches, setBatches] = useState<any[]>([]);
  const [report, setReport] = useState<string[] | null>(null);
  const load = () => api<any>('/imports').then((r) => setBatches(r.batches)).catch(() => {});
  useEffect(() => { load(); }, []);
  return (
    <Page title="Imports" sub="Everything comes in as a file you upload. No Sage credentials are stored or used anywhere.">
      <GLImport onSaved={load} />
      <Card title="Import history">
        {batches.length === 0 ? <p className="muted">No Sage imports yet.</p> : (
          <Scroll><table className="grid">
            <thead><tr><th>#</th><th>File</th><th>Months</th><th className="r">Lines</th><th className="r">Revenue</th><th className="r">Net income</th><th>Sage “Created on”</th><th>Imported</th><th>Tie-out</th><th /></tr></thead>
            <tbody>{batches.map((b) => (
              <tr key={b.id}><td>{b.id}</td><td>{b.file_name}</td><td>{b.period_from === b.period_to ? ymLabel(b.period_from) : `${ymLabel(b.period_from)} – ${ymLabel(b.period_to)}`}</td>
                <td className="r num">{fmt(b.row_count)}</td><td className="r num">{fmt(b.total_revenue, 2)}</td><td className={`r num ${neg(b.total_net_income)}`}>{fmt(b.total_net_income, 2)}</td>
                <td>{b.sage_created_on}<div className="muted small">{SAGE_OPEN}</div></td><td>{new Date(b.created_at).toLocaleString()} · {b.created_by}</td>
                <td>{!b.tieout.length ? <span className="muted">not checked</span> : b.tieout.every((t: any) => t.ok) ? <span className="pill ok">✓ tied</span> : <span className="pill bad">✗ did not tie</span>}</td>
                <td className="acts"><button className="link bad" onClick={() => window.confirm('Delete this import and its actuals?') && run(async () => { await api(`/imports/${b.id}`, { method: 'DELETE' }); clearActualsCache(); await load(); })}>Delete</button></td></tr>))}</tbody>
          </table></Scroll>
        )}
      </Card>
      <WorkbookImport />
      <Card title="Sage “P&L By Department” report">
        <p className="muted">Not built yet (planned as a fallback). That report carries line names only, no account numbers, so the General Ledger export above is the better source.</p>
      </Card>
      <Card title="Seed files">
        <p className="muted small">Reference data lives in the <code>/seed</code> folder: departments.csv, entities.csv, chart_of_accounts.csv, budget_lines_template.csv and the two drivers files. Until the real files are there, the made-up set in <code>/seed/sample</code> is used. Reloading is safe to repeat and never touches a scenario you have edited.</p>
        <button onClick={() => run(async () => { const r = await api<any>('/seed', { method: 'POST' }); setReport(r.report); toast('Seed files reloaded.'); }, 'both')}>Reload seed files</button>
        {report && <ul className="small">{report.map((r) => <li key={r}>{r}</li>)}</ul>}
      </Card>
    </Page>
  );
}
