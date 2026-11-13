import { useMemo, useState } from 'react';
import { useApp } from '../store';
import { Page, Card, NumCell, Scroll, Banner, fmt } from '../ui';
import { MONTHS, occupancyPct, revPar, roomsAvailable, spreadByShape, sum, zeros, type Num12 } from '../../../shared/calc';

export function Drivers() {
  const { bundle, ref, locked, setStats, fy, deptName, toast } = useApp();
  const [gRooms, setGRooms] = useState('0');
  const [gAdr, setGAdr] = useState('0');
  const [yearRooms, setYearRooms] = useState('');
  // last year (or two years back where last year is not in yet), per department and key
  const last = useMemo(() => {
    const out: Record<string, (number | null)[]> = {};
    const src: Record<string, number[]> = {};
    for (const back of [2, 1]) {
      for (const r of ref.statReference) {
        if (!r.ym.startsWith(`${fy - back}-`)) continue;
        const k = `${r.dept_id}|${r.key}`;
        const m = Number(r.ym.slice(5, 7)) - 1;
        (out[k] ??= new Array(12).fill(null))[m] = r.value;
        (src[k] ??= new Array(12).fill(0))[m] = fy - back;
      }
    }
    return { vals: out, years: src };
  }, [ref, fy]);
  if (!bundle) return <Page title="Drivers"><p className="muted">Pick or create a scenario first.</p></Page>;
  const s = bundle.stats;
  const occ = occupancyPct(s);
  const bad = occ.some((v) => v > 100 || v < 0);
  const cap = (m: number) => s.roomCount * s.days[m];
  const restaurants = [...new Set(['10', '12', '13', '15', ...Object.keys(s.covers),
    ...bundle.lines.filter((l) => l.driverType === 'PER_COVER' || l.driverType === 'COVERS_X_CHECK').map((l) => l.deptId)])]
    .filter((d) => ref.departments.some((x) => x.dept_id === d)).sort();
  const homes = [...new Set([...Object.keys(s.occRooms), ...bundle.lines.filter((l) => l.driverType === 'PER_OCC_ROOM' && l.deptId !== bundle.options.roomsDept).map((l) => l.deptId)])].sort();
  const ly = (dept: string, key: string) => last.vals[`${dept}|${key}`];
  const lyRow = (label: string, dept: string, key: string, dec = 0) => {
    const v = ly(dept, key);
    const yrs = last.years[`${dept}|${key}`];
    return v && (
      <tr className="lyrow"><td>{label}</td>{v.map((x, m) => <td key={m} className="r num" title={x === null ? '' : `from ${yrs?.[m] ?? ''}`}>{x === null ? '' : fmt(x, dec)}</td>)}
        <td className="r num tot">{dec === 0 ? fmt(sum(v)) : ''}</td></tr>
    );
  };
  const editRow = (label: string, vals: Num12, key: string, deptId: string, dec = 0, total: number | null = null) => (
    <tr key={`${deptId}|${key}`}><td className="name">{label}</td>
      {vals.map((v, m) => <td key={m} className="r"><NumCell value={v} dec={dec} disabled={locked} label={`${label} ${MONTHS[m]}`} onCommit={(nv) => setStats([{ deptId, month: m, key, value: nv ?? 0 }])} /></td>)}
      <td className="r num tot">{total === null ? '' : fmt(total, dec)}</td></tr>
  );
  const roRow = (label: string, vals: Num12, dec = 0, total: number | null = null, cls = '') => (
    <tr className={`ro ${cls}`}><td className="name">{label}</td>{vals.map((v, m) => <td key={m} className={`r num ${cls && (v > 100 || v < 0) ? 'neg' : ''}`}>{fmt(v, dec)}</td>)}<td className="r num tot">{total === null ? '' : fmt(total, dec)}</td></tr>
  );
  const applyGrowth = () => {
    const lr = ly('', 'rooms_sold'); const la = ly('', 'adr');
    if (!lr || !la) return toast('No HMS history is loaded to grow from.', true);
    const items: any[] = [];
    for (let m = 0; m < 12; m++) {
      if (lr[m] !== null) items.push({ deptId: '', month: m, key: 'rooms_sold', value: Math.round(lr[m]! * (1 + Number(gRooms) / 100) * 10) / 10 });
      if (la[m] !== null) items.push({ deptId: '', month: m, key: 'adr', value: Math.round(la[m]! * (1 + Number(gAdr) / 100) * 100) / 100 });
    }
    setStats(items);
  };
  const fillShape = () => {
    const n = Number(yearRooms.replace(/[,\s]/g, ''));
    const shape = ly('', 'rooms_sold');
    if (!Number.isFinite(n) || !n || !shape) return toast('Enter a yearly total; HMS history is needed for the shape.', true);
    setStats(spreadByShape(n, shape).map((v, m) => ({ deptId: '', month: m, key: 'rooms_sold', value: Math.round(v * 10) / 10 })));
  };
  const capacity = sum(s.days) * s.roomCount;
  const roomRev = s.roomsSold.map((v, m) => v * s.adr[m]);
  return (
    <Page title="Drivers" sub={`Statistics behind the budget for ${bundle.scenario.name}. Occupied rooms feed CPOR lines; covers feed CPC lines.`}>
      {bad && <Banner kind="bad"><strong>Check occupancy.</strong> At least one month is above 100% or below 0%.</Banner>}
      <Card title="Build the year quickly">
        <div className="toolbar">
          <label>Rooms sold growth over last year % <input value={gRooms} onChange={(e) => setGRooms(e.target.value)} inputMode="decimal" size={5} /></label>
          <label>ADR growth % <input value={gAdr} onChange={(e) => setGAdr(e.target.value)} inputMode="decimal" size={5} /></label>
          <button disabled={locked} onClick={applyGrowth}>Apply to all 12 months</button>
          <span className="sep" />
          <label>Yearly rooms sold <input value={yearRooms} onChange={(e) => setYearRooms(e.target.value)} inputMode="decimal" size={8} placeholder="e.g. 23000" /></label>
          <button disabled={locked} onClick={fillShape}>Fill the year from last year’s shape</button>
        </div>
        <p className="muted small">Or type occupancy % and ADR month by month below. New scenarios start from the same month last year.</p>
      </Card>
      <Card title={`Rooms (${s.roomCount} rooms)`}>
        <Scroll><table className="grid">
          <thead><tr><th>Statistic</th>{MONTHS.map((m) => <th key={m} className="r">{m}</th>)}<th className="r">Year</th></tr></thead>
          <tbody>
            {roRow('Days', s.days, 0, sum(s.days))}
            {editRow('Out-of-order room nights', s.ooo, 'ooo_room_nights', '', 0, sum(s.ooo))}
            {roRow(`Rooms available (${s.roomCount} x days, minus OOO)`, roomsAvailable(s), 0, sum(roomsAvailable(s)))}
            {editRow('Rooms sold (occupied rooms)', s.roomsSold, 'rooms_sold', '', 1, sum(s.roomsSold))}
            {lyRow('  last year', '', 'rooms_sold')}
            <tr><td className="name">Occupancy %</td>
              {occ.map((v, m) => <td key={m} className="r"><NumCell value={v} dec={1} disabled={locked} className={v > 100 || v < 0 ? 'neg' : ''} label={`Occupancy ${MONTHS[m]}`}
                onCommit={(nv) => setStats([{ deptId: '', month: m, key: 'rooms_sold', value: Math.round(((nv ?? 0) / 100) * cap(m) * 10) / 10 }])} /></td>)}
              <td className="r num tot">{fmt(capacity ? (100 * sum(s.roomsSold)) / capacity : 0, 1)}</td></tr>
            {lyRow('  last year', '', 'occupancy_pct', 1)}
            {editRow('ADR', s.adr, 'adr', '', 2, sum(s.roomsSold) ? sum(roomRev) / sum(s.roomsSold) : 0)}
            {lyRow('  last year', '', 'adr', 2)}
            {roRow('RevPAR', revPar(s), 2, capacity ? sum(roomRev) / capacity : 0)}
            {roRow('Rooms sold x ADR', roomRev, 0, sum(roomRev))}
          </tbody>
        </table></Scroll>
        <p className="muted small">
          To drive room revenue from these, set the Chalets line’s driver to “Rooms sold x ADR” on the Budget page (rate 1 = all of it; split with Suites by giving each a share).
          Resort fee and pet fee lines can use “CPOR (per occupied room)”. HMS is the source for occupancy and ADR; Sage is the source for dollars.
        </p>
      </Card>
      {homes.length > 0 && (
        <Card title="Occupied rooms for other departments (rental homes)">
          <Scroll><table className="grid">
            <thead><tr><th>Department</th>{MONTHS.map((m) => <th key={m} className="r">{m}</th>)}<th className="r">Year</th></tr></thead>
            <tbody>{homes.map((d) => editRow(deptName(d), s.occRooms[d] ?? zeros(), 'occ_rooms', d, 1, sum(s.occRooms[d] ?? zeros())))}</tbody>
          </table></Scroll>
        </Card>
      )}
      <Card title="Restaurants: covers and average check">
        <Scroll><table className="grid">
          <thead><tr><th>Statistic</th>{MONTHS.map((m) => <th key={m} className="r">{m}</th>)}<th className="r">Year</th></tr></thead>
          {restaurants.map((d) => {
            const cv = s.covers[d] ?? zeros(); const ch = s.avgCheck[d] ?? zeros();
            const sales = cv.map((v, m) => v * ch[m]);
            return (
              <tbody key={d}>
                <tr className="section"><td colSpan={14}>{deptName(d)}</td></tr>
                {editRow('Covers', cv, 'covers', d, 0, sum(cv))}
                {lyRow('  last year', d, 'covers')}
                {editRow(d === '15' ? 'Sales per check' : 'Average check', ch, 'avg_check', d, 2, sum(cv) ? sum(sales) / sum(cv) : 0)}
                {lyRow('  last year', d, 'avg_check', 2)}
                {roRow('Covers x check', sales, 0, sum(sales))}
              </tbody>
            );
          })}
        </table></Scroll>
        <p className="muted small">Ducey’s on the Lake and Pines Bar &amp; Grill are added together as department 10. Pines Bar covers equal checks, so its figure is sales per check.</p>
      </Card>
    </Page>
  );
}
