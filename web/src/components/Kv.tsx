import { type ReactNode } from 'react'

export function Kv({ k, v, cls }: { k: ReactNode; v: ReactNode; cls?: string }) {
  return (
    <div className="kv">
      <span>{k}</span>
      <span className={cls}>{v}</span>
    </div>
  )
}
