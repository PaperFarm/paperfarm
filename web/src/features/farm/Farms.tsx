import { useState } from 'react'
import { Chevron, CoinMark } from '../../components/icons.tsx'
import { Dial, TP_MAX, TP_MIN } from './Ticket.tsx'
import { act, useDraft } from './actions.ts'
import { type Account } from '../../lib/account.ts'
import { type Market } from '../../lib/api.ts'
import { compact, pct, signed, tone, usd, usdc } from '../../lib/format.ts'
import { type Farm, type PairView, exposure } from '../../lib/pairs.ts'
import { cycle } from '../../lib/paper.ts'
import * as api from '../../lib/me.ts'

/** Standing farms: each keeps its pairs open and reopens them as they close, on the server. */
export function Farms({ farms, views, market }: { farms: Farm[]; views: PairView[]; market: Market | null }) {
  if (!farms.length) return null
  return (
    <div className="farms" aria-label="Farms">
      {farms.map((f) => (
        <FarmRow key={f.id} f={f} views={views.filter((v) => v.rec.farm === f.id)} market={market} />
      ))}
    </div>
  )
}

function FarmRow({ f, views, market }: { f: Farm; views: PairView[]; market: Market | null }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [tp, setTp] = useDraft(f.tp * 100, `farm-tp-${f.id}`, (v) => api.patchFarm(f.id, { tp: v / 100 }))
  const info = market?.coins[f.coin]
  const proj = info && market ? cycle(info.impact, market.rate, f.notional, f.lev, tp / 100) : null
  const openPairs = views.filter((v) => v.long.pos || v.short.pos)
  const state = !f.running ? ['Stopped', 'off'] : f.status ? ['Waiting', 'wait'] : ['Running', '']
  async function run(fn: () => Promise<unknown>, ok?: string) {
    setBusy(true)
    await act(fn, ok)
    setBusy(false)
  }
  return (
    <div className={`farm ${f.running ? (f.status ? 'waiting' : 'hedged') : ''}`}>
      <div className="farm-main">
        <div className="asset">
          <CoinMark coin={f.coin} className="mini" />
          <b>{f.coin}</b>
          <span className={`tag ${state[1]}`}>farm · {state[0]}</span>
        </div>
        <div className="farm-spec">
          {f.lev}× · {usd(f.notional, 0)} a leg · closes at {pct(f.tp)} · {f.slots} {f.slots > 1 ? 'pairs' : 'pair'} at
          a time
        </div>
        <div className="farm-figs">
          <span>
            <span className="lbl">Rounds</span>
            {f.closed}
          </span>
          <span>
            <span className="lbl">PAPER</span>
            {compact(f.paper)}
          </span>
          <span>
            <span className="lbl">Net</span>
            <span className={tone(f.pnl)}>{signed(f.pnl)}</span>
          </span>
          <span>
            <span className="lbl">Cost / 1K</span>
            {f.paper > 0 ? usd((-f.pnl / f.paper) * 1000) : proj ? `~${usd(proj.costPer1k)}` : '—'}
          </span>
        </div>
        <div className="row acts">
          <button className={`btn sm ${open ? 'on' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open}>
            Adjust <Chevron />
          </button>
          {f.running ? (
            <button
              className="btn sm"
              disabled={busy}
              onClick={() =>
                run(
                  () => api.patchFarm(f.id, { running: false }),
                  'Farm paused; its open pairs still close at their take-profit',
                )
              }
              title="Stop opening new pairs; open pairs still close at their take-profit"
            >
              Pause
            </button>
          ) : (
            <button
              className="btn sm"
              disabled={busy}
              onClick={() => run(() => api.patchFarm(f.id, { running: true }), 'Farm resumed')}
            >
              Resume
            </button>
          )}
          {openPairs.length > 0 ? (
            <button
              className="btn sm close"
              disabled={busy}
              onClick={() =>
                run(
                  () => api.stopFarm(f.id),
                  `${f.coin} farm stopped; closing ${openPairs.length} pair${openPairs.length > 1 ? 's' : ''}`,
                )
              }
            >
              Stop & close
            </button>
          ) : (
            !f.running && (
              <button className="linkbtn" disabled={busy} onClick={() => run(() => api.deleteFarm(f.id))}>
                Remove
              </button>
            )
          )}
        </div>
      </div>
      {f.status && f.running && <div className="farm-status">{f.status}</div>}
      {open && (
        <div className="adjust">
          <div>
            <Dial
              label="Close when price moves"
              value={`${tp.toFixed(2)}%`}
              min={TP_MIN}
              max={TP_MAX}
              step={0.05}
              v={tp}
              set={setTp}
              left="Faster rounds"
              right="Cheaper PAPER"
            />
            <div className="note">Applies to its open pairs right away and to every pair it opens next.</div>
          </div>
          <div className="adj-mid">
            <div className="row">
              <span className="grow small ink2">Pairs at a time</span>
              <span className="seg sm" role="group" aria-label="Pairs at a time">
                <button
                  disabled={busy || f.slots <= 1}
                  onClick={() => run(() => api.patchFarm(f.id, { slots: f.slots - 1 }))}
                  aria-label="One fewer"
                >
                  −
                </button>
                <button className="on" tabIndex={-1}>
                  {f.slots}
                </button>
                <button
                  disabled={busy || f.slots >= 10}
                  onClick={() => run(() => api.patchFarm(f.id, { slots: f.slots + 1 }))}
                  aria-label="One more"
                >
                  +
                </button>
              </span>
            </div>
            {proj && (
              <div className="kv">
                <span>Each round</span>
                <span>
                  {compact(proj.paper)} PAPER · {usd(proj.costPer1k)} / 1K
                </span>
              </div>
            )}
            <div className="note">
              Size ({usd(f.notional, 0)} a leg) and leverage ({f.lev}x) are fixed per farm; start a new farm to change
              them.
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** Is the account actually delta-neutral? Long notional minus short notional, per coin, over every open position. */
export function Exposure({ a }: { a: Account }) {
  const ex = Object.entries(exposure(Object.values(a.positions)))
  if (!ex.length) return null
  return (
    <div className="expo" aria-label="Net exposure">
      <span className="lbl">Net exposure</span>
      {ex.map(([coin, e]) => {
        const flat = Math.abs(e.net) <= Math.max(1, e.gross * 0.01)
        return (
          <span key={coin} className={`expo-coin ${flat ? 'pos' : 'neg'}`}>
            <CoinMark coin={coin} className="tickmark" />
            {coin}
            <b>{flat ? 'neutral' : `${usdc(Math.abs(e.net))} ${e.net > 0 ? 'long' : 'short'}`}</b>
            <span className="muted">of {usdc(e.gross)}</span>
          </span>
        )
      })}
    </div>
  )
}
