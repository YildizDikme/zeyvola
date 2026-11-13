import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './icons';
import { t } from '../i18n';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'record';

export function Button(props: {
  children?: ReactNode;
  icon?: IconName;
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
  wide?: boolean;
}) {
  const { variant = 'secondary', size = 'md' } = props;
  return (
    <button
      type={props.type ?? 'button'}
      className={`btn btn-${variant} btn-${size}${props.wide ? ' btn-wide' : ''}${props.children ? '' : ' btn-icon-only'}`}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
    >
      {props.icon && <Icon name={props.icon} size={size === 'sm' ? 15 : 17} />}
      {props.children && <span>{props.children}</span>}
    </button>
  );
}

export function IconButton(props: { icon: IconName; label: string; onClick?: () => void; active?: boolean; disabled?: boolean; size?: number }) {
  return (
    <button
      type="button"
      className={`icon-btn${props.active ? ' is-active' : ''}`}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.label}
      aria-label={props.label}
      aria-pressed={props.active}
    >
      <Icon name={props.icon} size={props.size ?? 17} />
    </button>
  );
}

export function Segmented<T extends string>(props: {
  value: T;
  options: { value: T; label: string; icon?: IconName }[];
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
  label?: string;
}) {
  return (
    <div className={`segmented segmented-${props.size ?? 'md'}`} role="radiogroup" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === props.value}
          className={o.value === props.value ? 'is-on' : ''}
          onClick={() => props.onChange(o.value)}
        >
          {o.icon && <Icon name={o.icon} size={15} />}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  const id = useId();
  return (
    <label className={`toggle-row${props.disabled ? ' is-disabled' : ''}`} htmlFor={id}>
      <span className="toggle-text">
        <span>{props.label}</span>
        {props.hint && <small>{props.hint}</small>}
      </span>
      <input id={id} type="checkbox" role="switch" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden="true"><span className="toggle-thumb" /></span>
    </label>
  );
}

export function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  onCommit?: () => void;
}) {
  const id = useId();
  const pct = ((props.value - props.min) / (props.max - props.min)) * 100;
  return (
    <div className="slider-row">
      <label htmlFor={id}>{props.label}</label>
      <output htmlFor={id}>{props.format ? props.format(props.value) : props.value.toFixed(2)}</output>
      <input
        id={id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 0.01}
        value={props.value}
        style={{ ['--pct' as string]: `${pct}%` }}
        onChange={(e) => props.onChange(Number(e.target.value))}
        onPointerUp={props.onCommit}
        onKeyUp={props.onCommit}
      />
    </div>
  );
}

export function Select<T extends string>(props: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="select-row">
      <label htmlFor={id}>{props.label}</label>
      <div className="select-wrap">
        <select id={id} value={props.value} disabled={props.disabled} onChange={(e) => props.onChange(e.target.value as T)}>
          {props.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <Icon name="chevronDown" size={14} />
      </div>
    </div>
  );
}

export function Section(props: { title: string; children: ReactNode; action?: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(props.defaultOpen ?? true);
  return (
    <section className={`section${open ? ' is-open' : ''}`}>
      <header>
        <button type="button" className="section-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          <Icon name="chevronRight" size={14} />
          <span>{props.title}</span>
        </button>
        {props.action}
      </header>
      {open && <div className="section-body">{props.children}</div>}
    </section>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'record' | 'success' | 'warning' }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Swatch(props: { colors: string[]; active?: boolean; label: string; onClick: () => void }) {
  const bg = props.colors.length === 1
    ? props.colors[0]
    : `radial-gradient(circle at 25% 20%, ${props.colors[2] ?? props.colors[1]} 0%, transparent 55%), radial-gradient(circle at 80% 85%, ${props.colors[3] ?? props.colors[1]} 0%, transparent 50%), linear-gradient(135deg, ${props.colors[0]}, ${props.colors[1]})`;
  return (
    <button type="button" className={`swatch${props.active ? ' is-on' : ''}`} title={props.label} aria-label={props.label} onClick={props.onClick}>
      <span style={{ background: bg }} />
    </button>
  );
}

export function ColorInput(props: { label: string; value: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <div className="color-row">
      <label htmlFor={id}>{props.label}</label>
      <span className="color-chip" style={{ background: props.value }}>
        <input id={id} type="color" value={props.value} onChange={(e) => props.onChange(e.target.value)} />
      </span>
      <code>{props.value.toUpperCase()}</code>
    </div>
  );
}

/** Text that turns into an input on double click (project names). */
export function EditableText(props: { value: string; onCommit: (v: string) => void; className?: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => setDraft(props.value), [props.value]);
  useEffect(() => { if (editing) ref.current?.select(); }, [editing]);
  if (!editing) {
    return <button type="button" className={`editable ${props.className ?? ''}`} onDoubleClick={() => setEditing(true)} title={t("Yeniden adlandırmak için çift tıklayın")}>{props.value}</button>;
  }
  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft !== props.value) props.onCommit(draft.trim());
    else setDraft(props.value);
  };
  return (
    <input
      ref={ref}
      className={`editable-input ${props.className ?? ''}`}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') { setDraft(props.value); setEditing(false); }
      }}
    />
  );
}

export function Empty(props: { icon: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon"><Icon name={props.icon} size={22} /></span>
      <strong>{props.title}</strong>
      {props.children && <p>{props.children}</p>}
    </div>
  );
}
