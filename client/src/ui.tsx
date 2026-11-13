import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MONTHS, sum, type Num12 } from '../../shared/calc';

/** US dollars, thousands separators, negatives in parentheses. */
export function fmt(n: number | null | undefined, dec = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '';
  const r = Math.abs(n) < 0.5 * 10 ** -dec ? 0 : n;
  const s = Math.abs(r).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return r < 0 ? `(${s})` : s;
}
export const money = (n: number | null | undefined, dec = 0) => (n === null || n === undefined ? '' : n < 0 ? `(${'$'}${fmt(-n, dec)})` : `$${fmt(n, dec)}`);
export const pct = (n: number | null | undefined, dec = 1) => (n === null || n === undefined || !Number.isFinite(n) ? '' : `${fmt(n, dec)}%`);
export const neg = (n: number | null | undefined) => (n !== null && n !== undefined && n < -0.005 ? 'neg' : '');

export function parseInput(text: string): number | null {
  let s = text.trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s) || s.startsWith('-');
  const isPct = s.endsWith('%');
  s = s.replace(/[$,()%\s-]/g, '');
  let mult = 1;
  if (/k$/i.test(s)) { mult = 1e3; s = s.slice(0, -1); } else if (/m$/i.test(s)) { mult = 1e6; s = s.slice(0, -1); }
  const n = Number(s) * mult;
  if (!Number.isFinite(n)) return NaN;
  void isPct;
  return negative ? -n : n;
}

interface NumCellProps {
  value: number | null | undefined;
  onCommit?: (v: number | null) => void;
  disabled?: boolean;
  dec?: number;
  /** show and edit as a percent: 0.009 <-> 0.9 */
  asPct?: boolean;
  className?: string;
  placeholder?: string;
  title?: string;
  label?: string;
  /** what the user edits when it differs from what is shown (the typed input behind a lever) */
  editValue?: number | null;
}
/** Spreadsheet-style cell. Type 1200, 1.2k, (500) or -500. Enter saves, Esc cancels. Empty clears. */
export function NumCell({ value, onCommit, disabled, dec = 0, asPct, className = '', placeholder, title, label, editValue }: NumCellProps) {
  const [text, setText] = useState<string | null>(null);
  const cancelled = useRef(false);
  const shown = value === null || value === undefined ? '' : asPct ? `${fmt(value * 100, Math.max(dec, 2))}%` : fmt(value, dec);
  if (disabled || !onCommit) return <span className={`num ro ${neg(value)} ${className}`} title={title}>{shown || placeholder || ''}</span>;
  const ev = editValue === undefined ? value : editValue;
  const raw = ev === null || ev === undefined ? '' : String(asPct ? +(ev * 100).toFixed(6) : +ev.toFixed(6));
  return (
    <input
      className={`num cell ${neg(value)} ${className}`} inputMode="decimal" title={title} aria-label={label} placeholder={placeholder}
      value={text ?? shown}
      onFocus={(e) => { cancelled.current = false; setText(raw); requestAnimationFrame(() => e.target.select()); }}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') { cancelled.current = true; (e.target as HTMLInputElement).blur(); }
      }}
      onBlur={() => {
        const t = text;
        setText(null);
        if (cancelled.current || t === null || t === raw) return;
        const v = parseInput(t);
        if (Number.isNaN(v)) return;
        onCommit(v === null ? null : asPct ? v / 100 : v);
      }}
    />
  );
}

export function TextCell({ value, onCommit, disabled, placeholder, className = '' }: { value: string; onCommit: (v: string) => void; disabled?: boolean; placeholder?: string; className?: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input className={`cell text ${className}`} value={text} disabled={disabled} placeholder={placeholder}
      onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      onBlur={() => { if (text !== value) onCommit(text); }} />
  );
}

export function MonthHead({ total = true, first }: { total?: boolean; first?: ReactNode }) {
  return (
    <tr>
      {first}
      {MONTHS.map((m) => <th key={m} className="r">{m}</th>)}
      {total && <th className="r">Total</th>}
    </tr>
  );
}
export function MonthCells({ vals, dec = 0, total = true, totalValue }: { vals: Num12; dec?: number; total?: boolean; totalValue?: number | null }) {
  return (
    <>
      {vals.map((v, m) => <td key={m} className={`r num ${neg(v)}`}>{fmt(v, dec)}</td>)}
      {total && <td className={`r num tot ${neg(totalValue ?? sum(vals))}`}>{totalValue === null ? '' : fmt(totalValue ?? sum(vals), dec)}</td>}
    </>
  );
}

export function Page({ title, sub, actions, children }: { title: string; sub?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>{title}</h1>{sub && <p className="muted">{sub}</p>}</div>
        {actions && <div className="row gap">{actions}</div>}
      </div>
      {children}
    </div>
  );
}
export const Card = ({ title, children, className = '' }: { title?: ReactNode; children: ReactNode; className?: string }) => (
  <section className={`card ${className}`}>{title && <h2>{title}</h2>}{children}</section>
);
export const Banner = ({ kind = 'warn', children }: { kind?: 'warn' | 'bad' | 'ok' | 'info'; children: ReactNode }) => (
  <div className={`banner ${kind}`} role={kind === 'bad' ? 'alert' : 'note'}>{children}</div>
);
export const Scroll = ({ children }: { children: ReactNode }) => <div className="scroll">{children}</div>;
export const Seg = <T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string][] }) => (
  <div className="seg" role="group">
    {options.map(([v, label]) => <button key={v} type="button" className={v === value ? 'on' : ''} aria-pressed={v === value} onClick={() => onChange(v)}>{label}</button>)}
  </div>
);
export const SAGE_OPEN = 'Sage period open, not closed: numbers can still change';
