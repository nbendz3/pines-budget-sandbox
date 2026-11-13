import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  computeScenario, summarizeScenario, computeCash,
  type Line, type Stats, type Adjustment, type EngineOptions, type Opt12, type ScenarioResult, type Num12,
} from '../../shared/calc';

export async function api<T = any>(path: string, opts: { method?: string; body?: any; form?: FormData } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body || opts.form ? 'POST' : 'GET'),
    headers: { 'x-requested-with': 'pbs', ...(opts.body ? { 'content-type': 'application/json' } : {}) },
    body: opts.form ?? (opts.body ? JSON.stringify(opts.body) : undefined),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') window.dispatchEvent(new Event('pbs-signed-out'));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

export interface Bundle {
  scenario: any; lines: Line[]; stats: Stats; adjustments: Adjustment[];
  cash: Record<string, Opt12>; cashNotes: Record<string, string>; options: EngineOptions;
}
export interface Ref {
  entities: any[]; departments: any[]; accounts: any[]; scenarios: any[]; settings: Record<string, string>;
  statReference: { dept_id: string; ym: string; key: string; value: number; source: string }[];
}
export function compute(b: Bundle) {
  const result = computeScenario(b.lines, b.stats, b.adjustments, b.options);
  const summary = summarizeScenario(b.lines, result.byLine);
  const cash = computeCash(b.cash, summary.ebitda, summary.interest);
  return { result, summary, cash };
}

interface Ctx {
  ref: Ref; reloadRef: () => Promise<void>;
  scenarioId: number | null; setScenarioId: (id: number) => void;
  bundle: Bundle | null; reloadBundle: () => Promise<void>;
  result: ScenarioResult | null; summary: Record<string, Num12> | null; cash: ReturnType<typeof computeCash> | null;
  locked: boolean; fy: number;
  setCells: (cells: { lineId: number; month: number; field: 'typed' | 'override'; value: number | null }[]) => void;
  patchLine: (lineId: number, patch: Partial<Line>) => void;
  setStats: (items: { deptId: string; month: number; key: string; value: number | null }[]) => void;
  setCash: (key: string, month: number, amount: number | null) => void;
  setCashNote: (key: string, note: string) => void;
  run: (fn: () => Promise<any>, reload?: 'bundle' | 'ref' | 'both') => Promise<void>;
  toast: (msg: string, bad?: boolean) => void;
  deptName: (id: string | null) => string;
}
const C = createContext<Ctx>(null as any);
export const useApp = () => useContext(C);

export function AppProvider({ children }: { children: ReactNode }) {
  const [ref, setRef] = useState<Ref | null>(null);
  const [scenarioId, setSid] = useState<number | null>(null);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [note, setNote] = useState<{ msg: string; bad: boolean } | null>(null);
  const timer = useRef<any>();
  const toast = useCallback((msg: string, bad = false) => {
    setNote({ msg, bad });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setNote(null), bad ? 7000 : 2500);
  }, []);

  const reloadRef = useCallback(async () => {
    const r = await api<Ref>('/ref');
    setRef(r);
    setSid((cur) => {
      if (cur && r.scenarios.some((s) => s.id === cur)) return cur;
      const saved = Number(localStorage.getItem('pbs-scenario'));
      return r.scenarios.find((s) => s.id === saved)?.id ?? r.scenarios[r.scenarios.length - 1]?.id ?? null;
    });
  }, []);
  const reloadBundle = useCallback(async () => {
    if (!scenarioId) { setBundle(null); return; }
    setBundle(await api<Bundle>(`/scenarios/${scenarioId}/bundle`));
  }, [scenarioId]);
  useEffect(() => { reloadRef().catch((e) => toast(e.message, true)); }, [reloadRef, toast]);
  useEffect(() => { setBundle(null); reloadBundle().catch((e) => toast(e.message, true)); }, [reloadBundle, toast]);

  const setScenarioId = (id: number) => { try { localStorage.setItem('pbs-scenario', String(id)); } catch { /* private mode */ } setSid(id); };
  const calc = useMemo(() => (bundle ? compute(bundle) : null), [bundle]);
  const fail = useCallback((e: any) => { toast(e.message, true); reloadBundle().catch(() => {}); }, [toast, reloadBundle]);
  const sid = scenarioId;

  const ctx: Ctx | null = ref && {
    ref, reloadRef, scenarioId, setScenarioId, bundle, reloadBundle,
    result: calc?.result ?? null, summary: calc?.summary ?? null, cash: calc?.cash ?? null,
    locked: bundle?.scenario.status === 'LOCKED', fy: bundle?.scenario.fiscal_year ?? (Number(ref.settings.fiscal_year) || 2027),
    toast,
    deptName: (id) => (id === null || id === '' ? 'No department' : `${id} ${ref.departments.find((d) => d.dept_id === id)?.dept_name ?? ''}`.trim()),
    setCells: (cells) => {
      setBundle((b) => b && {
        ...b, lines: b.lines.map((l) => {
          const mine = cells.filter((c) => c.lineId === l.id);
          if (!mine.length) return l;
          const typed = [...l.typed]; const override = [...l.override];
          for (const c of mine) (c.field === 'typed' ? typed : override)[c.month] = c.value;
          return { ...l, typed, override };
        }),
      });
      api(`/scenarios/${sid}/cells`, { method: 'PUT', body: { cells } }).catch(fail);
    },
    patchLine: (lineId, patch) => {
      setBundle((b) => b && { ...b, lines: b.lines.map((l) => (l.id === lineId ? { ...l, ...patch } : l)) });
      api(`/lines/${lineId}`, { method: 'PATCH', body: patch }).catch(fail);
    },
    setStats: (items) => {
      setBundle((b) => {
        if (!b) return b;
        const s: Stats = { ...b.stats, roomsSold: [...b.stats.roomsSold], adr: [...b.stats.adr], ooo: [...b.stats.ooo],
          covers: { ...b.stats.covers }, avgCheck: { ...b.stats.avgCheck }, occRooms: { ...b.stats.occRooms } };
        for (const it of items) {
          const v = it.value ?? 0;
          if (it.key === 'rooms_sold') s.roomsSold[it.month] = v;
          else if (it.key === 'adr') s.adr[it.month] = v;
          else if (it.key === 'ooo_room_nights') s.ooo[it.month] = v;
          else {
            const t = it.key === 'covers' ? s.covers : it.key === 'avg_check' ? s.avgCheck : s.occRooms;
            t[it.deptId] = [...(t[it.deptId] ?? new Array(12).fill(0))];
            t[it.deptId][it.month] = v;
          }
        }
        return { ...b, stats: s };
      });
      api(`/scenarios/${sid}/stats`, { method: 'PUT', body: { items } }).catch(fail);
    },
    setCash: (key, month, amount) => {
      setBundle((b) => {
        if (!b) return b;
        const row = [...(b.cash[key] ?? new Array(12).fill(null))];
        row[month] = amount;
        return { ...b, cash: { ...b.cash, [key]: row } };
      });
      api(`/scenarios/${sid}/cash`, { method: 'PUT', body: { items: [{ key, month, amount }] } }).catch(fail);
    },
    setCashNote: (key, n) => {
      setBundle((b) => b && { ...b, cashNotes: { ...b.cashNotes, [key]: n } });
      api(`/scenarios/${sid}/cash`, { method: 'PUT', body: { notes: [{ key, note: n }] } }).catch(fail);
    },
    run: async (fn, reload = 'bundle') => {
      try {
        await fn();
        if (reload === 'ref' || reload === 'both') await reloadRef();
        if (reload === 'bundle' || reload === 'both') await reloadBundle();
      } catch (e: any) { toast(e.message, true); }
    },
  };

  if (!ctx) return <div className="center muted">Loading…</div>;
  return (
    <C.Provider value={ctx}>
      {children}
      {note && <div className={`toast ${note.bad ? 'bad' : ''}`} role="status">{note.msg}</div>}
    </C.Provider>
  );
}
