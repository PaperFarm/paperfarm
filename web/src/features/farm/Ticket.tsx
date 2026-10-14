import { useEffect, useState } from 'react'
import { CoinMark } from '../../components/icons.tsx'
import { act } from './actions.ts'
import { COINS } from './types.ts'
import { type Account } from '../../lib/account.ts'
import { type Market, pairRoom } from '../../lib/api.ts'
import { compact, pct, usd, usdc } from '../../lib/format.ts'
import { type CoinName, bustMove, cycle } from '../../lib/paper.ts'
import { priceOf, usePrices } from '../../lib/prices.ts'
import { keep, store } from '../../lib/storage.ts'
import { connect } from '../../lib/wallet.ts'
import * as api from '../../lib/me.ts'

// ---- the order panel ----

// Three ways to farm. Fine-tune moves the same two dials, take-profit and leverage, within safe bounds.
const SPEEDS = [
  { id: 'steady', name: 'Steady', lev: 10, tp: 1, note: 'Closes at a 1% move. Cheapest PAPER, fewer rounds.' },
  { id: 'balanced', name: 'Balanced', lev: 20, tp: 0.5, note: 'Closes at a 0.5% move. The usual middle.' },
  { id: 'fast', name: 'Fast', lev: 50, tp: 0.3, note: 'Closes at a 0.3% move. More rounds, pricier PAPER.' },
] as const
type SpeedId = (typeof SPEEDS)[number]['id'] | 'custom'
export const TP_MIN = 0.1
export const TP_MAX = 2 // take-profit bounds, %
const LEV_MIN = 2
const LEV_MAX = 100

export function Ticket({
  market,
  a,
  user,
  coin,
  setCoin,
  connecting,
}: {
  market: Market | null
  a: Account | null
  user: string
  coin: CoinName
  setCoin: (c: CoinName) => void
  connecting: boolean
}) {
  const { mids } = usePrices()
  const { keyReady } = api.useSession()
  const [budget, setBudget] = useState(() => store('pf:t:budget', '200'))
  const [speed, setSpeed] = useState<SpeedId>(() => store('pf:t:speed', 'balanced') as SpeedId)
  const [lev, setLev] = useState(() => Number(store('pf:t:lev', '20')))
  const [tp, setTp] = useState(() => Number(store('pf:t:tp', '0.5')))
  const [pairs, setPairs] = useState(1)
  const [auto, setAuto] = useState(true)
  const [keepOn, setKeepOn] = useState(true)
  const [tune, setTune] = useState(false)
  const [busy, setBusy] = useState('')
  useEffect(() => {
    keep('pf:t:budget', budget)
    keep('pf:t:speed', speed)
    keep('pf:t:lev', String(lev))
    keep('pf:t:tp', String(tp))
  }, [budget, speed, lev, tp])
  const pick = (x: (typeof SPEEDS)[number]) => {
    setSpeed(x.id)
    setLev(x.lev)
    setTp(x.tp)
  }
  const dial = (f: () => void) => {
    f()
    setSpeed('custom')
  }

  const info = market?.coins[coin]
  const room = info && market ? pairRoom(info, market.netOiCap, priceOf(mids, coin)) : Infinity
  const sp = SPEEDS.find((x) => x.id === speed)
  // The amount is the margin of every pair together, split evenly across pairs and their two legs.
  const B = Number(budget) || 0
  const n = (B / pairs / 2) * lev
  const tpF = tp / 100
  const mid = priceOf(mids, coin)
  const bm = bustMove(lev)
  const c = info && market && n > 0 ? cycle(info.impact, market.rate, n, lev, tpF) : null
  const minBudget = market ? Math.ceil(2 * pairs * Math.max(market.minMargin, market.minNotional / lev)) : 0
  const avail = a?.avail ?? 0

  // [why the pair can't open, the same in a few words for the button, a one-click fix]
  type Block = [string, string, { label: string; run: () => void }?]
  const block: Block = !a
    ? ['', '']
    : !market
      ? ['', 'Loading…']
      : !info?.openable || market.paused.includes('openPosition')
        ? [`Papertrade is not taking ${coin} opens right now.`, 'Opens paused']
        : market.paused.includes('closePositions')
          ? ['Papertrade has paused closes; a pair opened now could not be closed.', 'Closes paused']
          : a.lifetime.deposited === 0 && a.balance === 0
            ? [
                'This wallet has no balance on Papertrade. Connect the wallet you farm with, or fund this one on papertrade.xyz.',
                'No Papertrade balance',
              ]
            : B < minBudget
              ? [
                  `${pairs > 1 ? `${pairs} pairs` : 'A pair'} at ${lev}x needs at least ${usd(minBudget, 0)}: Papertrade's smallest position is ${usd(market.minNotional, 0)} with ${usd(market.minMargin, 0)} of margin.`,
                  `At least ${usd(minBudget, 0)}`,
                  minBudget <= avail
                    ? { label: `Use ${usd(minBudget, 0)}`, run: () => setBudget(String(minBudget)) }
                    : undefined,
                ]
              : n > info.maxNotional
                ? [
                    `Each leg would be ${usdc(n)}; Papertrade allows ${usdc(info.maxNotional)}.`,
                    'Too large',
                    {
                      label: `Split into ${Math.ceil((n * pairs) / info.maxNotional)} pairs`,
                      run: () => setPairs(Math.min(10, Math.ceil((n * pairs) / info.maxNotional))),
                    },
                  ]
                : n > room
                  ? [
                      `Papertrade's open interest limit leaves room for ${usdc(room)} a leg right now.`,
                      'Over the open interest limit',
                      (room * 2 * pairs) / lev >= minBudget
                        ? {
                            label: `Use ${usd(Math.floor((room * 2 * pairs) / lev), 0)}`,
                            run: () => setBudget(String(Math.floor((room * 2 * pairs) / lev))),
                          }
                        : undefined,
                    ]
                  : B > avail
                    ? [
                        `You have ${usd(avail)} available.`,
                        'Not enough available',
                        {
                          label: `Use ${usd(Math.floor(avail * 0.995), 0)}`,
                          run: () => setBudget(String(Math.floor(avail * 0.995))),
                        },
                      ]
                    : ['', '']
  const [problem, blocked, fix] = block
  // Papertrade warns the same way: another trade landing first can take the last of the room
  const nearCap = !problem && info && n > 0 && room < Infinity && room - n >= 0 && room - n <= Math.max(room / 20, 1000)

  async function go() {
    setBusy('Preparing…')
    const spec = { coin, notional: n, lev, tp: tpF }
    if (keepOn) {
      await act(() => api.startFarm({ ...spec, slots: pairs }), `${coin} farm started`, setBusy)
    } else {
      await act(
        async () => {
          for (let i = 0; i < pairs; i++) {
            setBusy(pairs > 1 ? `Sending pair ${i + 1} of ${pairs}…` : 'Sending both legs…')
            await api.openPair({ ...spec, auto })
          }
        },
        `${pairs > 1 ? `${pairs} ${coin} pairs` : `${coin} pair`} sent. Each leg fills when Papertrade's queue reaches it.`,
        setBusy,
      )
    }
    setBusy('')
  }

  return (
    <div className="ticket">
      {!a && (
        <p className="small ink2">
          {connecting
            ? 'Connecting to your Papertrade account…'
            : 'Connect the wallet you trade with on Papertrade to farm with its balance.'}
        </p>
      )}

      <div className="seg" role="group" aria-label="Market">
        {COINS.map((x) => (
          <button key={x} className={x === coin ? 'on' : ''} onClick={() => setCoin(x)} aria-pressed={x === coin}>
            <CoinMark coin={x} className="mini" />
            {x}
          </button>
        ))}
      </div>

      <div>
        <div className="labelrow">
          <span className="small ink2">{a ? `Available ${usd(avail)}` : 'Your margin, split across both legs'}</span>
          <label className="lbl" htmlFor="amt">
            Amount (USDC)
          </label>
        </div>
        <div className="inputrow">
          <span className="chips">
            {[0.25, 0.5, 1].map((f) => (
              <button
                key={f}
                className="chip"
                disabled={!a}
                onClick={() => setBudget(String(Math.floor(avail * f * 0.995)))}
              >
                {f === 1 ? 'MAX' : `${f * 100}%`}
              </button>
            ))}
          </span>
          <span className="field">
            <input
              id="amt"
              inputMode="decimal"
              value={budget}
              onChange={(e) => setBudget(e.target.value.replace(/[^0-9.]/g, ''))}
            />
          </span>
        </div>
      </div>

      <div>
        <div className="labelrow">
          <span className="small ink2">How fast to farm</span>
          <span className="lbl">Speed</span>
        </div>
        <div className="speeds" role="radiogroup" aria-label="Speed">
          {SPEEDS.map((x) => {
            const cx = info && market ? cycle(info.impact, market.rate, 100_000, x.lev, x.tp / 100) : null
            return (
              <button
                key={x.id}
                role="radio"
                aria-checked={speed === x.id}
                className={speed === x.id ? 'on' : ''}
                onClick={() => pick(x)}
              >
                <b>{x.name}</b>
                <span>{cx ? `${usd(cx.costPer1k)} / 1K` : `${x.tp}%`}</span>
              </button>
            )
          })}
        </div>
        <div className="speednote">
          <span className="small ink2">{sp ? sp.note : `Your own: ${lev}x, closes at a ${tp}% move.`}</span>
          <button className="linkbtn" onClick={() => setTune(!tune)} aria-expanded={tune}>
            {tune ? 'Done' : 'Fine-tune'}
          </button>
        </div>
      </div>

      {tune && (
        <div className="tune" aria-label="Fine-tune">
          <Dial
            label="Close when price moves"
            value={`${tp.toFixed(2)}%`}
            min={TP_MIN}
            max={TP_MAX}
            step={0.05}
            v={tp}
            set={(v) => dial(() => setTp(v))}
            left="Faster rounds"
            right="Cheaper PAPER"
          />
          <Dial
            label="Leverage"
            value={`${lev}x`}
            min={LEV_MIN}
            max={LEV_MAX}
            step={1}
            v={lev}
            set={(v) => dial(() => setLev(v))}
            lev
            left="Safer"
            right="Bigger size"
            note={
              tpF >= bm
                ? `At ${lev}x the losing leg liquidates at a ${pct(bm)} move, before your take-profit. That is fine for farming (it mints on its whole margin) and the other leg closes right then.`
                : `Each leg liquidates at a ${pct(bm)} move, well past your take-profit.`
            }
          />
          <div className="row">
            <span className="grow small ink2">
              Split into {pairs > 1 ? `${pairs} pairs of ${usd(B / pairs, 0)}` : 'one pair'}
            </span>
            <span className="seg sm" role="group" aria-label="Number of pairs">
              <button onClick={() => setPairs(Math.max(1, pairs - 1))} aria-label="One pair fewer">
                −
              </button>
              <button className="on" aria-live="polite" tabIndex={-1}>
                {pairs}
              </button>
              <button onClick={() => setPairs(Math.min(10, pairs + 1))} aria-label="One pair more">
                +
              </button>
            </span>
          </div>
          <label className="toggle">
            <input type="checkbox" className="switch" checked={keepOn} onChange={(e) => setKeepOn(e.target.checked)} />
            Keep farming: reopen a pair every time one closes
          </label>
          {!keepOn && (
            <label className="toggle">
              <input type="checkbox" className="switch" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
              Close automatically at the take-profit
            </label>
          )}
          {speed === 'custom' && (
            <button className="linkbtn" onClick={() => pick(SPEEDS[1])}>
              Reset to Balanced
            </button>
          )}
        </div>
      )}

      {c && (
        <div className="result" aria-label="What one round does">
          <div>
            <span className="lbl">{keepOn ? 'Each round mints' : 'Mints'}</span>
            <b>
              {compact(c.paper * pairs)} <small>PAPER</small>
            </b>
          </div>
          <div>
            <span className="lbl">Cost per 1K</span>
            <b>{usd(c.costPer1k)}</b>
          </div>
          <p>
            {pairs > 1 ? `${pairs} pairs, each a` : 'A'} {usd(n, 0)} long and short at {lev}x, closed when {coin} moves{' '}
            {tp}%{c.busts ? ` (the losing leg liquidates first, at ${pct(bm)})` : ''}.{' '}
            {mid ? (
              <>
                Liquidation at {usd(mid * (1 - bm), 0)} / {usd(mid * (1 + bm), 0)}.
              </>
            ) : null}
          </p>
        </div>
      )}

      {!user ? (
        <button className="cta" onClick={connect}>
          Connect wallet
        </button>
      ) : (
        <button className="cta" disabled={!a || !!blocked || !!busy} onClick={go}>
          {busy || blocked || (keepOn ? 'Start farming' : pairs > 1 ? `Open ${pairs} pairs once` : 'Open one pair')}
        </button>
      )}
      {problem && (
        <div className="alert bad" role="status">
          {problem}
          {fix && (
            <>
              {' '}
              <button className="chip sm" onClick={fix.run}>
                {fix.label}
              </button>
            </>
          )}
        </div>
      )}
      {nearCap && (
        <div className="alert" role="status">
          Near the open interest limit: an open may be refused if another trade lands first.
        </div>
      )}
      {keepOn && user && (
        <div className="hint">
          Each pair closes when price moves {tp}% and the next one opens, until you stop the farm.
        </div>
      )}
      {a && !keyReady && !busy && (
        <div className="hint">
          Starting asks your wallet to sign in, then to approve a trading key for a week. The key can open and close
          positions on Papertrade, never withdraw.
        </div>
      )}
    </div>
  )
}

/** A labelled slider that says what moving it does. */
export function Dial({
  label,
  value,
  min,
  max,
  step,
  v,
  set,
  left,
  right,
  note,
  lev,
}: {
  label: string
  value: string
  min: number
  max: number
  step: number
  v: number
  set: (v: number) => void
  left: string
  right: string
  note?: string
  lev?: boolean
}) {
  return (
    <div className="dial">
      <div className="labelrow">
        <span className="small">{label}</span>
        <b>{value}</b>
      </div>
      <input
        className={lev ? 'lev' : 'lev plain'}
        type="range"
        min={min}
        max={max}
        step={step}
        value={Math.min(max, Math.max(min, v))}
        onChange={(e) => set(Number(e.target.value))}
        aria-label={label}
        aria-valuetext={value}
      />
      <div className="scale">
        <span>{left}</span>
        <span>{right}</span>
      </div>
      {note && <div className="note">{note}</div>}
    </div>
  )
}
