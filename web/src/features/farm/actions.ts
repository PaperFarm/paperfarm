import { useState } from 'react'
import { toast } from '../../components/Toasts.tsx'
import { type Position } from '../../lib/paper.ts'
import { errText } from '../../lib/wallet.ts'
import * as api from '../../lib/me.ts'

// ---- actions ----

/** Runs an action on the server: signs in and sets up the trading key first when needed, then reports the outcome. */
export async function act(
  f: () => Promise<unknown>,
  ok?: string,
  onStep: (s: string) => void = () => {},
): Promise<boolean> {
  try {
    await api.ready(onStep)
    await f()
    if (ok) toast(ok)
    return true
  } catch (e) {
    toast(errText(e), true)
    return false
  }
}

/** A slider edited locally and sent once the hand stops; the server's value shows again after. */
export function useDraft(
  value: number,
  key: string,
  send: (v: number) => Promise<unknown>,
): [number, (v: number) => void] {
  const [draft, setDraft] = useState<number | null>(null)
  return [
    draft ?? value,
    (v) => {
      setDraft(v)
      api.debounced(key, () =>
        send(v)
          .catch((e) => toast(errText(e), true))
          .finally(() => setDraft(null)),
      )
    },
  ]
}

export function openPnl(p: Position, mid: number) {
  return mid ? (p.long ? mid / p.entry - 1 : 1 - mid / p.entry) * p.margin * p.leverage : 0
}
