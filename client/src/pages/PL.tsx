import { useMemo, useState } from 'react';
import { useApp } from '../store';
import { Page, Scroll, Seg, Banner, fmt, pct, neg } from '../ui';
import { useActuals, actualItems, actualsByAccount, useStatus, ActualsBanners } from '../actuals';
import { MONTHS, SUMMARY_LAYOUT, SAGE_SECTIONS, summarize, sageSection, normalizeBucket, isRevenueAccount, zeros, add12, sub12, sum, type Num12 } from '../../../shared/calc';

type Period = 'M' | 'Q' | 'Y';
export interface PLRow {
  label: string; style?: 'total' | 'pct' | 'head' | 'sub';
  vals?: Num12; cmp?: Num12;
  pctOf?: { num: Num12; den: Num12; cnum?: Num12; cden?: Num12 };
}
const GROUPS: Record<Period, { label: string; months: number[] }[]> = {
  M: MONTHS.map((m, i) => ({ label: m, months: [i] })),
  Q: [0, 1, 2, 3].map((qi) => ({ label: `Q${qi + 1}`, months: [qi * 3, qi * 3 + 1, qi * 3 + 2] })),
  Y: [],
};
const part = (a: Num12 | undefined, months: number[]) => (a ? months.reduce((t, m) => t + (a[m] || 0), 0) : 0);
const ALL = MONTHS.map((_, i) => i);

export function PLTable({ rows, period, cmpLabel }: { rows: PLRow[]; period: Period; cmpLabel?: string }) {
  const groups = [...GROUPS[period], { label: period === 'Y' ? 'Year' : 'Total', months: ALL }];
  const cmp = !!cmpLabel;
  return (
    <Scroll>
      <table className="grid pl">
        <thead>
          <tr><th rowSpan={cmp ? 2 : 1} />{groups.map((g) => <th key={g.label} colSpan={cmp ? 4 : 1} className={cmp ? 'c grp' : 'r'}>{g.label}</th>)}</tr>
          {cmp && <tr>{groups.map((g) => [<th key={`${g.label}a`} className="r">Scenario</th>, <th key={`${g.label}b`} className="r">{cmpLabel}</th>, <th key={`${g.label}c`} className="r">Var $</th>, <th key={`${g.label}d`} className="r grp">Var %</th>])}</tr>}
        </thead>
        <tbody>
          {rows.map((r, i) => {
            if (r.style === 'head') return <tr key={i} className="section"><td colSpan={1 + groups.length * (cmp ? 4 : 1)}>{r.label}</td></tr>;
            return (
              <tr key={i} className={r.style === 'total' ? 'total' : r.style === 'pct' ? 'pctrow' : r.style === 'sub' ? 'subtotal' : ''}>
                <td className="name">{r.label}</td>
                {groups.map((g) => {
                  let a: number; let b: number | null = null;
                  if (r.pctOf) {
                    const d = part(r.pctOf.den, g.months);
                    a = d ? (100 * part(r.pctOf.num, g.months)) / d : 0;
                    if (cmp && r.pctOf.cden) { const cd = part(r.pctOf.cden, g.months); b = cd ? (100 * part(r.pctOf.cnum, g.months)) / cd : 0; }
                  } else { a = part(r.vals, g.months); if (cmp) b = part(r.cmp, g.months); }
                  const f = (x: number) => (r.pctOf ? pct(x) : fmt(x));
                  if (!cmp) return <td key={g.label} className={`r num ${neg(a)}`}>{f(a)}</td>;
                  const v = a - (b ?? 0);
                  return [
                    <td key={`${g.label}a`} className={`r num ${neg(a)}`}>{f(a)}</td>,
                    <td key={`${g.label}b`} className={`r num ${neg(b)}`}>{f(b ?? 0)}</td>,
                    <td key={`${g.label}c`} className={`r num ${neg(v)}`}>{r.pctOf ? `${fmt(v, 1)} pts` : fmt(v)}</td>,
                    <td key={`${g.label}d`} className={`r num grp ${neg(v)}`}>{r.pctOf || !b ? '' : pct((100 * v) / Math.abs(b))}</td>,
                  ];
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </Scroll>
  );
}

export function PL() {
  const { bundle, result, ref, fy } = useApp();
  const [layout, setLayout] = useState<'B' | 'S'>('B');
  const [period, setPeriod] = useState<Period>('M');
  const [entity, setEntity] = useState('ALL');
  const [cmp, setCmp] = useState<'NONE' | 'ACT' | 'PY'>('NONE');
  const cmpYear = cmp === 'ACT' ? fy : cmp === 'PY' ? fy - 1 : null;
  const actuals = useActuals(cmpYear);
  const status = useStatus();

  const rows: PLRow[] = useMemo(() => {
    if (!bundle || !result) return [];
    const lines = bundle.lines.filter((l) => entity === 'ALL' || (l.entityId ?? 'E100') === entity);
    const has = cmpYear !== null && actuals !== null;
    if (layout === 'B') {
      const s = summarize(lines.map((l) => ({ bucket: normalizeBucket(l.summaryRow, l.deptId, l.sheet), kind: l.kind, amounts: result.byLine[l.id] ?? zeros() })));
      const a = has ? summarize(actualItems(actuals!, ref, entity)) : null;
      return SUMMARY_LAYOUT.filter((d) => d.key !== 'NO_DEPT' || (a && sum(a.NO_DEPT.map(Math.abs)) > 0)).map((d) =>
        d.style === 'head' ? { label: d.label, style: 'head' as const }
          : d.style === 'pct' ? { label: d.label, style: 'pct' as const, pctOf: { num: s[d.of!], den: s.total_rev, cnum: a?.[d.of!], cden: a?.total_rev } }
            : { label: d.label, style: d.style, vals: s[d.key], cmp: a?.[d.key] });
    }
    // Sage layout: account by account under Sage's own sections
    const byAcct: Record<string, Num12> = {};
    for (const l of lines) byAcct[l.account] = add12(byAcct[l.account] ?? zeros(), result.byLine[l.id] ?? zeros());
    const act = has ? actualsByAccount(actuals!, entity) : {};
    const accts = [...new Set([...Object.keys(byAcct), ...Object.keys(act)])].sort();
    const name = (acct: string) => ref.accounts.find((x) => x.account === acct);
    const out: PLRow[] = [];
    let ni = zeros(); let niC = zeros();
    for (const sec of SAGE_SECTIONS) {
      const mine = accts.filter((x) => sageSection(name(x)?.pl_section, x) === sec);
      if (!mine.length) continue;
      out.push({ label: sec, style: 'head' });
      let t = zeros(); let tc = zeros();
      for (const x of mine) {
        const v = byAcct[x] ?? zeros(); const c = act[x] ?? zeros();
        // a revenue account sitting in a cost section (or the reverse) is shown with the section's sign
        const flip = isRevenueAccount(x) !== (sec === 'Revenue') ? -1 : 1;
        const vv = v.map((n) => n * flip); const cc = c.map((n) => n * flip);
        t = add12(t, vv); tc = add12(tc, cc);
        out.push({ label: `${x} ${name(x)?.name ?? ''}`, vals: vv, cmp: has ? cc : undefined });
      }
      out.push({ label: `Total ${sec}`, style: 'sub', vals: t, cmp: has ? tc : undefined });
      ni = sec === 'Revenue' ? add12(ni, t) : sub12(ni, t);
      niC = sec === 'Revenue' ? add12(niC, tc) : sub12(niC, tc);
    }
    out.push({ label: 'Net Income (Revenue minus all cost sections)', style: 'total', vals: ni, cmp: has ? niC : undefined });
    return out;
  }, [bundle, result, layout, entity, actuals, cmpYear, ref]);

  if (!bundle) return <Page title="P&L"><p className="muted">Pick or create a scenario first.</p></Page>;
  return (
    <Page title="P&L" sub={layout === 'B' ? 'Your Summary P&L layout, rolled up by each line’s summary row.' : 'Sage’s consolidated P&L sections, account by account. Costs are positive.'}
      actions={<button onClick={() => window.print()}>Print</button>}>
      <div className="toolbar">
        <Seg value={layout} onChange={setLayout} options={[['B', 'Budget layout'], ['S', 'Sage layout']]} />
        <Seg value={period} onChange={setPeriod} options={[['M', 'Month'], ['Q', 'Quarter'], ['Y', 'Year']]} />
        <label>Entity <select value={entity} onChange={(e) => setEntity(e.target.value)}><option value="ALL">All</option>{ref.entities.map((e) => <option key={e.entity_id}>{e.entity_id}</option>)}</select></label>
        <label>Variance <select value={cmp} onChange={(e) => setCmp(e.target.value as any)}>
          <option value="NONE">Off</option><option value="ACT">vs {fy} actuals</option><option value="PY">vs {fy - 1} actuals (last year)</option>
        </select></label>
      </div>
      {cmpYear !== null && <ActualsBanners status={status} year={cmpYear} />}
      {cmpYear !== null && actuals !== null && actuals.length === 0 && <Banner kind="info">No Sage actuals are loaded for {cmpYear} yet. Load a General Ledger export on the Imports page.</Banner>}
      <PLTable rows={rows} period={period} cmpLabel={cmpYear !== null && actuals ? `${cmpYear} actual` : undefined} />
    </Page>
  );
}
