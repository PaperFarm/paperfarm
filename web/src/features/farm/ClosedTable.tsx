import { CoinMark } from '../../components/icons.tsx'
import { act } from './actions.ts'
import { compact, signed, tone, usd } from '../../lib/format.ts'
import { type PairView } from '../../lib/pairs.ts'
import * as api from '../../lib/me.ts'

// ---- closed pairs ----

export function ClosedTable({ views }: { views: PairView[] }) {
  if (!views.length)
    return (
      <div className="empty">
        Pairs you close show here with what they cost and minted. The Stats page has your full history.
      </div>
    )
  return (
    <div className="ctable">
      <div className="thead" aria-hidden="true">
        <span>Pair</span>
        <span className="r">Size</span>
        <span className="r">Long</span>
        <span className="r">Short</span>
        <span className="r">Net</span>
        <span className="r">PAPER</span>
        <span className="r">Cost / 1K</span>
      </div>
      <div className="rows">
        {views.slice(0, 30).map((v) => {
          const lc = v.long.closed,
            sc = v.short.closed
          const known = !!(lc && sc)
          const net = (lc?.pnl ?? 0) + (sc?.pnl ?? 0),
            paper = (lc?.paper ?? 0) + (sc?.paper ?? 0)
          return (
            <div key={v.rec.id} className="prow" role="row">
              <div className="asset" data-l="Pair">
                <CoinMark coin={v.rec.coin} className="mini" />
                <b>{v.rec.coin}</b>
                <span className={`tag ${v.state === 'failed' ? 'bad' : ''}`}>
                  {v.rec.lev}× {v.state === 'failed' ? 'not opened' : 'closed'}
                </span>
              </div>
              <div className="num" data-l="Size">
                {usd(v.rec.notional, 0)} ×2
              </div>
              <div className={`num ${tone(lc?.pnl ?? 0)}`} data-l="Long">
                {lc ? signed(lc.pnl) : '—'}
              </div>
              <div className={`num ${tone(sc?.pnl ?? 0)}`} data-l="Short">
                {sc ? signed(sc.pnl) : '—'}
              </div>
              <div className={`num strong ${tone(net)}`} data-l="Net">
                {known ? signed(net) : '—'}
              </div>
              <div className="num" data-l="PAPER">
                {known ? compact(paper) : '—'}
              </div>
              <div className="num strong" data-l="Cost / 1K">
                {known && paper > 0 ? usd((-net / paper) * 1000) : '—'}
              </div>
            </div>
          )
        })}
      </div>
      <div className="tablefoot">
        <span className="small muted">Recent closes. Stats has the full history.</span>
        <button
          className="linkbtn"
          onClick={() =>
            act(async () => {
              for (const v of views) await api.patchPair(v.rec.id, { archived: true })
            })
          }
        >
          Clear
        </button>
      </div>
    </div>
  )
}
