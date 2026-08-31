import type { ButtonHTMLAttributes, ReactNode } from 'react'

/** Small shared primitives. Every one is plain markup over global.css. */

export function Card({
  title,
  right,
  children,
  flush = false,
  className = ''
}: {
  title?: ReactNode
  right?: ReactNode
  children: ReactNode
  flush?: boolean
  className?: string
}) {
  return (
    <section className={`card ${flush ? 'pad0' : ''} ${className}`.trim()}>
      {(title || right) && (
        <div className="row between" style={flush ? { padding: '12px 16px 0' } : undefined}>
          {title ? <h3 className="card-title" style={{ margin: 0 }}>{title}</h3> : <span />}
          {right}
        </div>
      )}
      {flush ? <div style={{ marginTop: title ? 10 : 0 }}>{children}</div> : children}
    </section>
  )
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'danger' | 'ghost'
  size?: 'md' | 'sm'
}

export function Btn({ variant = 'default', size = 'md', className = '', ...rest }: BtnProps) {
  const classes = ['btn', variant === 'default' ? '' : variant, size === 'sm' ? 'sm' : '', className]
  return <button type="button" className={classes.filter(Boolean).join(' ')} {...rest} />
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <span className="dim small">{hint}</span>}
    </label>
  )
}

export function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled = false
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
}) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <div className="dim small">{hint}</div>}
      </span>
    </label>
  )
}

export const Pill = ({ tone = '', children }: { tone?: string; children: ReactNode }) => (
  <span className={`pill ${tone}`.trim()}>{children}</span>
)

export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>

export const ErrorNote = ({ error }: { error: string | null }) =>
  error ? (
    <div className="card" style={{ borderColor: 'rgba(248,113,113,0.5)', color: '#fca5a5' }}>
      {error}
    </div>
  ) : null

export function Bar({ value, tone }: { value: number; tone?: 'warn' | 'bad' }) {
  const pct = Math.max(0, Math.min(100, value))
  const auto = tone ?? (pct > 90 ? 'bad' : pct > 75 ? 'warn' : undefined)
  return (
    <div className="bar">
      <i className={auto ?? ''} style={{ width: `${pct}%` }} />
    </div>
  )
}

export function Metric({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="card">
      <div className="card-title" style={{ margin: 0 }}>
        {label}
      </div>
      <div className="metric">{value}</div>
      {sub && <div className="small muted">{sub}</div>}
    </div>
  )
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide = false
}: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  return (
    <div className="overlay" role="dialog" aria-modal="true" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal fade-in" style={wide ? { width: 'min(900px, 94vw)' } : undefined}>
        <header>
          <h2 className="grow">{title}</h2>
          <Btn size="sm" variant="ghost" onClick={onClose} aria-label="Close">
            ✕
          </Btn>
        </header>
        <div className="content">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  )
}
