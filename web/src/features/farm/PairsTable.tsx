import { useState } from 'react'
import { Chevron, CoinMark } from '../../components/icons.tsx'
import { useRanks } from './QueueTable.tsx'
import { Dial, TP_MAX, TP_MIN } from './Ticket.tsx'
import { act, openPnl, useDraft } from './actions.ts'
import { type Market } from '../../lib/api.ts'
import { ago, compact, pct, px, signed, tone, usd } from '../../lib/format.ts'
import { type Leg, type PairView } from '../../lib/pairs.ts'
import { closeNow, cycle } from '../../lib/paper.ts'
import { priceOf, usePrices } from '../../lib/prices.ts'
import * as api from '../../lib/me.ts'

export function PairsTable({ views, market }: { views: PairView[]; market: Market | null }) {
  if (!views.length) return <div className="empty">No pairs open.</div>
  return (
    <div className="ptable">
      <div className="thead" aria-hidden="true">
        <span>Pair</span>
        <span className="r">Size</span>
        <span className="r c-entry">Entry</span>
        <span className="r">Long</span>
        <span className="r">Short</span>
        <span className="r">Net now</span>
        <span>Bust ← move → bust</span>
        <span className="r">Close now</span>
        <span />
      </div>
      <div className="rows">
        {views.map((v) => (
          <PairRow key={v.rec.id} v={v} market={market} />
        ))}
      </div>
    </div>
  )
}

export const STATE: Record<string, [string, string, string]> = {
  // label, tag tone, row class
  sending: ['sending', 'wait', 'waiting'],
  queued: ['in queue', 'wait', 'waiting'],
  partial: ['1 of 2 filled', 'wait', 'waiting'],
  open: ['hedged', '', 'hedged'],
  broken: ['unhedged', 'bad', 'alone'],
  closing: ['closing', 'wait', 'waiting'],
  closed: ['closed', '', ''],
  failed: ['not opened', 'bad', ''],
}

function PairRow({ v, market }: { v: PairView; market: Market | null }) {
  const { mids } = usePrices()
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(v.state === 'broken') // a lone leg opens its options
  const r = v.rec,
    mid = priceOf(mids, r.coin)
  const [label, tagTone, rowCls] = STATE[v.state]
  const info = market?.coins[r.coin]
  const est =
    v.long.pos && v.short.pos && info && market && mid
      ? closeNow(info.impact, market.rate, v.long.pos, v.short.pos, mid)
      : null
  const gap = v.long.pos && v.short.pos ? v.long.pos.entry - v.short.pos.entry : 0
  const queued = v.long.status === 'queued' ? r.intents.long : v.short.status === 'queued' ? r.intents.short : undefined
  const anyOpen = !!(v.long.pos || v.short.pos)
  async function run(fn: () => Promise<unknown>, ok?: string) {
    setBusy(true)
    await act(fn, ok)
    setBusy(false)
  }

  return (
    <div className={`prow ${rowCls}`} role="row" aria-label={`${r.coin} pair, ${label}`}>
      <div className="asset" data-l="Pair">
        <CoinMark coin={r.coin} className="mini" />
        <b>{r.coin}</b>
        <span className={`tag ${tagTone}`}>
          {r.lev}× {label}
          {r.farm ? ' · farm' : ''}
        </span>
      </div>
      <div className="cell2" data-l="Size">
        <span className="strong">{usd(r.notional, 0)}</span>
        <span className="muted">×2 · {ago(r.createdAt)}</span>
      </div>
      <div className="cell2 c-entry" data-l="Entry">
        <span>{v.entry ? px(v.entry) : '—'}</span>
        {gap ? (
          <span
            className="muted"
            title="Long entry minus short entry. A gap the long pays above the short is lost to the pair."
          >
            gap {signed(gap)}
          </span>
        ) : (
          <span />
        )}
      </div>
      <LegCell l={v.long} mid={mid} name="Long" />
      <LegCell l={v.short} mid={mid} name="Short" />
      <div className="cell2" data-l="Net now">
        {est ? (
          <>
            <span className={`strong ${tone(est.net)}`}>{signed(est.net)}</span>
            <span className="muted" title="Before Papertrade's haircut on the winning leg">
              raw {signed(est.rawNet)}
            </span>
          </>
        ) : (
          <span className="muted">—</span>
        )}
      </div>
      <div data-l="Bust ← move → bust">
        {v.long.pos && v.short.pos && mid ? (
          <Rail v={v} mid={mid} />
        ) : (
          <span className="small muted">{v.state === 'broken' ? 'one leg alone' : 'waiting for both legs'}</span>
        )}
      </div>
      <div className="cell2" data-l="Close now">
        {est ? (
          <>
            <span>{compact(est.paper)} PAPER</span>
            <span className="muted">{est.paper > 0 ? `${usd(est.costPer1k)} / 1K` : 'nothing minted yet'}</span>
          </>
        ) : (
          <span className="muted">—</span>
        )}
      </div>
      <div className="row acts">
        {v.state !== 'failed' && (
          <button className={`btn sm ${open ? 'on' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open}>
            Adjust <Chevron />
          </button>
        )}
        {anyOpen && (
          <button
            className="btn sm close"
            disabled={busy || v.state === 'closing'}
            onClick={() => run(() => api.closePair(r.id), `${r.coin} pair: close sent`)}
          >
            {v.state === 'broken' ? 'Close leg' : v.state === 'closing' ? 'Closing' : 'Close'}
          </button>
        )}
        {queued && !anyOpen && (
          <button className="btn sm" disabled={busy} onClick={() => run(() => api.cancelIntent(queued), 'Cancel sent')}>
            Cancel
          </button>
        )}
        {v.state === 'broken' && !anyOpen && !queued && (
          <button className="linkbtn" onClick={() => run(() => api.patchPair(r.id, { archived: true }))}>
            Dismiss
          </button>
        )}
      </div>
      {open && <PairAdjust v={v} market={market} mid={mid} run={run} busy={busy} />}
    </div>
  )
}

/** Live adjustments to a running pair. Papertrade fixes a position's size and leverage once it opens; when it
 * closes, whether it closes by itself, and its hedge can change. */
function PairAdjust({
  v,
  market,
  mid,
  run,
  busy,
}: {
  v: PairView
  market: Market | null
  mid: number
  run: (fn: () => Promise<unknown>, ok?: string) => void
  busy: boolean
}) {
  const r = v.rec
  const [tp, setTp] = useDraft(r.tp * 100, `pair-tp-${r.id}`, (x) => api.patchPair(r.id, { tp: x / 100 }))
  const info = market?.coins[r.coin]
  const proj = info && market ? cycle(info.impact, market.rate, r.notional, r.lev, tp / 100) : null
  const entry = v.entry || mid
  const move = entry && mid ? mid / entry - 1 : 0
  const alone = v.state === 'broken' ? (v.long.pos ? 'short' : v.short.pos ? 'long' : null) : null
  return (
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
          left="Sooner"
          right="Cheaper PAPER"
        />
        {entry > 0 && (
          <div className="note">
            Closes at {usd(entry * (1 - tp / 100))} or {usd(entry * (1 + tp / 100))} · now {move >= 0 ? '+' : ''}
            {pct(move, 2)}
          </div>
        )}
      </div>
      <div className="adj-mid">
        {proj && (
          <div className="kv">
            <span>At that move</span>
            <span>
              {compact(proj.paper)} PAPER · {usd(proj.costPer1k)} / 1K
            </span>
          </div>
        )}
        <label className="toggle">
          <input
            type="checkbox"
            className="switch"
            checked={r.auto}
            disabled={busy}
            onChange={(e) => run(() => api.patchPair(r.id, { auto: e.target.checked }))}
          />
          {r.auto ? 'Closes by itself at the take-profit' : 'Closes only when you press Close'}
        </label>
        <div className="tiny muted">
          Size ({usd(r.notional, 0)} a leg) and leverage ({r.lev}x) stay fixed while it is open; to change them, close
          it and start a new pair.
        </div>
      </div>
      <div className="adj-act">
        {alone && (
          <button
            className="btn"
            disabled={busy}
            onClick={() => run(() => api.hedgePair(r.id), `Opening the missing ${alone}`)}
          >
            Re-hedge: open the {alone}
          </button>
        )}
        <button
          className="btn"
          disabled={busy}
          onClick={() =>
            run(
              () => api.openPair({ coin: r.coin, notional: r.notional, lev: r.lev, tp: r.tp, auto: r.auto }),
              `Another ${r.coin} pair sent`,
            )
          }
        >
          Add another like this
        </button>
      </div>
    </div>
  )
}

function LegCell({ l, mid, name }: { l: Leg; mid: number; name: string }) {
  const rank = useRanks()[l.op?.id ?? '']
  if (l.pos) {
    const pnl = openPnl(l.pos, mid)
    return (
      <div className="cell2" data-l={name}>
        <span className={tone(pnl)}>{signed(pnl)}</span>
        <span className="muted">bust {px(l.pos.bust)}</span>
      </div>
    )
  }
  if (l.closed)
    return (
      <div className="cell2" data-l={name}>
        <span className={tone(l.closed.pnl)}>{signed(l.closed.pnl)}</span>
        <span className="muted">{l.closed.liquidated ? 'busted' : 'closed'}</span>
      </div>
    )
  const text = {
    none: 'not sent',
    sending: 'accepted',
    queued: 'in queue',
    open: '',
    failed: 'failed',
    closed: 'closed',
  }[l.status]
  return (
    <div className="cell2" data-l={name}>
      <span className={l.status === 'failed' ? 'neg' : 'warm'}>{text}</span>
      <span className="muted">
        {l.status === 'queued' && l.op ? `${rank != null ? `#${rank} · ` : ''}${ago(l.op.at)}` : (l.why ?? '')}
      </span>
    </div>
  )
}

/** The hedge rail: from the long's bust to the short's, the TP band around entry, the price now. */
function Rail({ v, mid }: { v: PairView; mid: number }) {
  const lo = v.long.pos!.bust,
    hi = v.short.pos!.bust,
    span = hi - lo
  const at = (p: number) => Math.max(0, Math.min(100, ((p - lo) / span) * 100))
  const tLo = at(v.entry * (1 - v.rec.tp)),
    tHi = at(v.entry * (1 + v.rec.tp))
  const move = mid / v.entry - 1
  const hit = Math.abs(move) >= v.rec.tp
  return (
    <div className="rail" title={`Move ${pct(move, 3)} of a ${pct(v.rec.tp)} take-profit`}>
      <span className="pct" style={{ left: `${at(mid)}%` }}>
        {move >= 0 ? '+' : ''}
        {pct(move, 2)}
      </span>
      <div className="line" />
      <div className="band" style={{ left: `${tLo}%`, width: `${tHi - tLo}%` }} />
      <div className="entry" style={{ left: `${at(v.entry)}%` }} />
      <div className={`now ${hit ? 'hit' : ''}`} style={{ left: `${at(mid)}%` }} />
    </div>
  )
}
