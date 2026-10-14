import { CoinMark } from '../../components/icons.tsx'
import { act, openPnl } from './actions.ts'
import { type Market } from '../../lib/api.ts'
import { px, signed, tone, usd } from '../../lib/format.ts'
import { findPairs } from '../../lib/pairs.ts'
import { type Position, closeNow } from '../../lib/paper.ts'
import { priceOf, usePrices } from '../../lib/prices.ts'
import * as api from '../../lib/me.ts'

// ---- positions opened elsewhere ----

export function Others({ found, market }: { found: ReturnType<typeof findPairs>; market: Market | null }) {
  const { mids } = usePrices()
  if (!found.pairs.length && !found.single.length)
    return (
      <div className="empty">
        No other positions. Pairs and legs opened outside paperfarm (on papertrade.xyz or by a bot) show here.
      </div>
    )
  const closeIds = (ids: string[]) => act(() => api.closePositions(ids), 'Close sent')
  /** Turns a lone position into a pair: the server tracks it and opens the opposite leg at the same size and leverage. */
  const hedge = (p: Position) =>
    act(() => api.hedgePosition(p.id), `Opening a ${p.long ? 'short' : 'long'} against #${p.id}; it shows in Pairs`)
  const adopt = (l: Position, s: Position) =>
    act(() => api.trackPositions(l.id, s.id), `Tracking ${l.coin} pair #${l.id}/#${s.id} in Pairs`)
  return (
    <div className="otable">
      <div className="thead" aria-hidden="true">
        <span>Position</span>
        <span className="r">Size</span>
        <span className="r">Entry</span>
        <span className="r">PnL</span>
        <span className="r">Bust</span>
        <span />
      </div>
      <div className="rows">
        {found.pairs.map(([l, s]) => {
          const mid = priceOf(mids, l.coin),
            info = market?.coins[l.coin]
          const est = info && market && mid ? closeNow(info.impact, market.rate, l, s, mid) : null
          return (
            <div key={l.id + s.id} className="prow hedged" role="row">
              <div className="asset" data-l="Position">
                <CoinMark coin={l.coin} className="mini" />
                <b>{l.coin}</b>
                <span className="tag">{l.leverage}× pair</span>
              </div>
              <div className="cell2" data-l="Size">
                <span className="strong">{usd(l.margin * l.leverage, 0)}</span>
                <span className="muted">×2</span>
              </div>
              <div className="cell2" data-l="Entry">
                <span>{px(l.entry)}</span>
                <span className="muted">short {px(s.entry)}</span>
              </div>
              <div className="cell2" data-l="PnL">
                <span className={tone(est?.net ?? 0)}>{est ? signed(est.net) : '—'}</span>
                <span className="muted">after haircut</span>
              </div>
              <div className="cell2" data-l="Bust">
                <span>{px(l.bust)}</span>
                <span className="muted">{px(s.bust)}</span>
              </div>
              <div className="row acts">
                <>
                  <button className="btn sm" onClick={() => adopt(l, s)}>
                    Track
                  </button>
                  <button className="btn sm close" onClick={() => closeIds([l.id, s.id])}>
                    Close
                  </button>
                </>
              </div>
            </div>
          )
        })}
        {found.single.map((p) => {
          const pnl = openPnl(p, priceOf(mids, p.coin))
          return (
            <div key={p.id} className="prow alone" role="row">
              <div className="asset" data-l="Position">
                <CoinMark coin={p.coin} className="mini" />
                <b>{p.coin}</b>
                <span className="tag bad">
                  {p.leverage}× {p.long ? 'long' : 'short'} · unhedged
                </span>
              </div>
              <div className="num strong" data-l="Size">
                {usd(p.margin * p.leverage, 0)}
              </div>
              <div className="num" data-l="Entry">
                {px(p.entry)}
              </div>
              <div className={`num ${tone(pnl)}`} data-l="PnL">
                {signed(pnl)}
              </div>
              <div className="num" data-l="Bust">
                {px(p.bust)}
              </div>
              <div className="row acts">
                <>
                  <button className="btn sm" onClick={() => hedge(p)}>
                    Hedge it
                  </button>
                  <button className="btn sm close" onClick={() => closeIds([p.id])}>
                    Close
                  </button>
                </>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
