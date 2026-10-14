import { useSyncExternalStore } from 'react'

// ---- toasts ----

let toasts: { id: number; text: string; bad?: boolean }[] = []
const toastSubs = new Set<() => void>()
export function toast(text: string, bad = false) {
  const id = Math.random()
  toasts = [...toasts, { id, text, bad }]
  toastSubs.forEach((f) => f())
  setTimeout(
    () => {
      toasts = toasts.filter((t) => t.id !== id)
      toastSubs.forEach((f) => f())
    },
    bad ? 9000 : 5000,
  )
}
export function Toasts() {
  const ts = useSyncExternalStore(
    (f) => {
      toastSubs.add(f)
      return () => toastSubs.delete(f)
    },
    () => toasts,
  )
  return (
    <div className="toast" role="status" aria-live="polite">
      {ts.map((t) => (
        <div key={t.id} className={t.bad ? 'bad' : ''}>
          {t.text}
        </div>
      ))}
    </div>
  )
}
