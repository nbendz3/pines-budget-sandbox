import { useEffect, useState } from 'react';
import { AppProvider, api, useApp } from './store';
import { Dashboard, Actuals } from './pages/Dashboard';
import { Budget } from './pages/Budget';
import { Drivers } from './pages/Drivers';
import { PL } from './pages/PL';
import { Scenarios } from './pages/Scenarios';
import { Compare } from './pages/Compare';
import { Cash } from './pages/Cash';
import { Imports } from './pages/Imports';
import { ChangeLog, Settings } from './pages/Admin';

const NAV: [string, string, () => JSX.Element][] = [
  ['dashboard', 'Dashboard', Dashboard], ['actuals', 'Actuals', Actuals], ['budget', 'Budget', Budget], ['drivers', 'Drivers', Drivers],
  ['pl', 'P&L', PL], ['scenarios', 'Scenarios', Scenarios], ['compare', 'Compare', Compare], ['cash', 'Cash Flow', Cash],
  ['imports', 'Imports', Imports], ['log', 'Change Log', ChangeLog], ['settings', 'Settings', Settings],
];
const route = () => window.location.hash.replace(/^#\/?/, '') || 'dashboard';

export function App() {
  const [me, setMe] = useState<{ authed: boolean; name: string | null; passwordSet: boolean } | null>(null);
  const check = () => api('/me').then(setMe).catch(() => setMe({ authed: false, name: null, passwordSet: true }));
  useEffect(() => {
    check();
    const out = () => setMe((m) => (m ? { ...m, authed: false } : m));
    window.addEventListener('pbs-signed-out', out);
    return () => window.removeEventListener('pbs-signed-out', out);
  }, []);
  if (!me) return <div className="center muted">Loading…</div>;
  if (!me.authed) return <Login passwordSet={me.passwordSet} onDone={check} />;
  return <AppProvider><Shell name={me.name ?? ''} onSignOut={() => api('/logout', { method: 'POST' }).then(check)} /></AppProvider>;
}

function Login({ passwordSet, onDone }: { passwordSet: boolean; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [name, setName] = useState(() => { try { return localStorage.getItem('pbs-name') ?? ''; } catch { return ''; } });
  const [err, setErr] = useState('');
  return (
    <div className="center">
      <form className="login card" onSubmit={(e) => {
        e.preventDefault();
        setErr('');
        api('/login', { body: { password, name } }).then(() => { try { localStorage.setItem('pbs-name', name); } catch { /* ignore */ } onDone(); }).catch((x) => setErr(x.message));
      }}>
        <div className="brand">Pines Budget Sandbox</div>
        <p className="muted small">Private. The Pines Resort’s financial data.</p>
        {!passwordSet && <div className="banner bad">No password has been set. In Replit, add a Secret named <code>APP_PASSWORD</code>, then restart the app.</div>}
        <label>Your name (shown in the change log)<input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required autoFocus /></label>
        {err && <div className="banner bad" role="alert">{err}</div>}
        <button className="primary">Sign in</button>
      </form>
    </div>
  );
}

function Shell({ name, onSignOut }: { name: string; onSignOut: () => void }) {
  const { ref, scenarioId, setScenarioId, bundle, locked } = useApp();
  const [page, setPage] = useState(route());
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const f = () => { setPage(route()); setOpen(false); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  const Current = (NAV.find(([k]) => k === page) ?? NAV[0])[2];
  return (
    <div className="shell">
      <aside className={`side ${open ? 'open' : ''}`}>
        <div className="brand">Pines Budget<br />Sandbox</div>
        <nav>{NAV.map(([k, label]) => <a key={k} href={`#/${k}`} className={k === page ? 'on' : ''} aria-current={k === page ? 'page' : undefined}>{label}</a>)}</nav>
        <div className="side-foot">
          <div className="small">Signed in as {name}</div>
          <button className="link" onClick={onSignOut}>Sign out</button>
        </div>
      </aside>
      <div className="main">
        <header className="top">
          <button className="menu" aria-label="Menu" onClick={() => setOpen(!open)}>☰</button>
          <label className="scen">Scenario
            <select value={scenarioId ?? ''} onChange={(e) => setScenarioId(Number(e.target.value))}>
              {ref.scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}{s.status === 'LOCKED' ? ' (locked)' : ''}</option>)}
            </select>
          </label>
          {bundle && <span className="muted small hide-sm">FY {bundle.scenario.fiscal_year} · {bundle.scenario.kind}</span>}
          {locked && <span className="badge lock">LOCKED</span>}
          {bundle?.scenario.is_sample && <span className="badge add">SAMPLE DATA</span>}
          <span className="grow" />
          {scenarioId && <>
            <a className="btn" href={`/api/scenarios/${scenarioId}/export.xlsx`}>Export to Excel</a>
            <a className="btn hide-sm" href={`/api/scenarios/${scenarioId}/export.csv`}>Export CSV</a>
          </>}
        </header>
        <main><Current /></main>
      </div>
    </div>
  );
}
