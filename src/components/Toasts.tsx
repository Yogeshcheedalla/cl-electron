import { useApp } from '../stores/app'

export function Toasts() {
  const { toasts, dismissToast } = useApp()
  if (!toasts.length) return null
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind} fade-in`} onClick={() => dismissToast(t.id)}>
          <strong>{t.title}</strong>
          {t.body && <div className="small muted">{t.body}</div>}
        </div>
      ))}
    </div>
  )
}
