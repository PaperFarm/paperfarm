import { useState } from 'react'
import { STATE } from './PairsTable.tsx'
import { act, openPnl } from './actions.ts'
import { signed, tone, usd } from '../../lib/format.ts'
import { type PairView } from '../../lib/pairs.ts'
import { priceOf, usePrices } from '../../lib/prices.ts'
import * as api from '../../lib/me.ts'

/** One pair under a chart: where it stands and its one action. */
export function WinPair({ v, n }: { v: PairView; n: number }) {
  const { mids } = usePrices()
  const [busy, setBusy] = useState(false)
  const mid = priceOf(mids, v.rec.coin)
  const [label, tagTone] = STATE[v.state]
  const net = (v.long.pos ? openPnl(v.long.pos, mid) : 0) + (v.short.pos ? openPnl(v.short.pos, mid) : 0)
  const to = v.entry && mid ? Math.abs(mid / v.entry - 1) / v.rec.tp : 0
  const anyOpen = !!(v.long.pos || v.short.pos)
  return (
    <div className="win-pair">
      <span className="muted">Pair {n}</span>
      <span className={`tag ${tagTone}`}>{label}</span>
      <span className="ink2">
        {usd(v.rec.notional, 0)} · {v.rec.lev}×
      </span>
      <span className={tone(net)}>{anyOpen ? signed(net) : '—'}</span>
      <span className="muted" title="How far price has moved toward the take-profit">
        {v.entry ? `${Math.min(100, Math.round(to * 100))}% to take-profit` : ''}
      </span>
      {anyOpen && (
        <button
          className="btn sm close"
          disabled={busy || v.state === 'closing'}
          onClick={async () => {
            setBusy(true)
            await act(() => api.closePair(v.rec.id), 'Close sent')
            setBusy(false)
          }}
        >
          {v.state === 'closing' ? 'Closing' : 'Close'}
        </button>
      )}
    </div>
  )
}
