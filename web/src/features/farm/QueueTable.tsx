import { useEffect, useSyncExternalStore } from 'react'
import { CoinMark } from '../../components/icons.tsx'
import { act } from './actions.ts'
import { useNow } from '../../hooks/useNow.ts'
import { ago, dur, usd } from '../../lib/format.ts'
import { type Op } from '../../lib/paper.ts'
import * as api from '../../lib/me.ts'

// ---- Papertrade's queue ----

let ranks: Record<string, number> = {}
const rankSubs = new Set<() => void>()
export const useRanks = () =>
  useSyncExternalStore(
    (f) => {
      rankSubs.add(f)
      return () => rankSubs.delete(f)
    },
    () => ranks,
  )
export function useRankPoller(user: string, active: boolean) {
  useEffect(() => {
    if (!active || !user) return
    const load = async () => {
      try {
        const j = await (await fetch(`/paper/queue-rank/accounts/${user}`)).json()
        ranks = Object.fromEntries(
          (j.entries ?? []).map((e: { intentId: string; position: number }) => [
            e.intentId.toLowerCase(),
            Number(e.position),
          ]),
        )
        rankSubs.forEach((f) => f())
      } catch {
        /* keep the last */
      }
    }
    load()
    const t = setInterval(load, 2000)
    return () => clearInterval(t)
  }, [user, active])
}

export function QueueTable({ ops }: { ops: Op[] }) {
  const { signedIn } = api.useSession()
  const rk = useRanks()
  const now = useNow(1000)
  if (!ops.length)
    return (
      <div className="empty">
        Nothing waiting. Papertrade accepts an intent at once and runs it from its queue, bigger trades first when busy;
        waiting intents show here.
      </div>
    )
  return (
    <div className="qtable">
      <div className="thead" aria-hidden="true">
        <span>Intent</span>
        <span className="r">Size</span>
        <span className="r">Place</span>
        <span className="r">Waiting</span>
        <span className="r">Expires</span>
        <span className="r">Id</span>
        <span />
      </div>
      <div className="rows">
        {ops.map((o) => (
          <div key={o.id} className="prow waiting" role="row">
            <div className="asset" data-l="Intent">
              {o.coin && <CoinMark coin={o.coin} className="mini" />}
              <b>{o.coin ?? ''}</b>
              <span className="tag wait">
                {o.action === 'openPosition'
                  ? `${o.leverage}× ${o.long ? 'long' : 'short'}`
                  : o.action === 'closePositions'
                    ? `close ${o.closes.length}`
                    : o.action}
              </span>
            </div>
            <div className="num" data-l="Size">
              {o.amount ? usd(o.amount * (o.leverage || 1), 0) : '—'}
            </div>
            <div className="num strong" data-l="Place">
              {rk[o.id] != null ? `#${rk[o.id]}` : '—'}
            </div>
            <div className="num" data-l="Waiting">
              {ago(o.at)}
            </div>
            <div className="num" data-l="Expires">
              {o.deadline ? (o.deadline > now ? `in ${dur(o.deadline - now)}` : 'expired') : '—'}
            </div>
            <div className="num muted small" data-l="Id">
              {o.id.slice(0, 10)}…
            </div>
            <div className="row acts">
              {signedIn && (
                <button className="btn sm" onClick={() => act(() => api.cancelIntent(o.id), 'Cancel sent')}>
                  Cancel
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
