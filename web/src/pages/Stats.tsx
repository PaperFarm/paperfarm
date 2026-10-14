import { useMemo, useState, type ReactNode } from 'react'
import { useStream, type Account } from '../lib/account.ts'
import { usePoll, type Market, type Stats as S } from '../lib/api.ts'
import { connect, useWallet } from '../lib/wallet.ts'
import { deriveProtocol, paybackDays, type History, type Protocol, type Summary } from '../lib/protocol.ts'
import { priceOf, usePrices } from '../lib/prices.ts'
import { Curve } from '../components/Curve.tsx'
import { compact, day, pct, px, signed, tone, usd, usdc, when, whenUTC } from '../lib/format.ts'

/** Staking yield not yet claimed: staked x accumulator / 1e27 - rewardDebt + pendingBase. */
export function pendingYield(a: Account, accRaw: string | undefined): number {
  if (!accRaw) return 0
  const r = (a.paper.stakedRaw * BigInt(accRaw)) / 10n ** 27n - a.paper.rewardDebt + a.paper.pendingBase
  return r > 0n ? Number(r) / 1e18 : 0
}

export function Cell({ k, v, s, cls, lead }: { k: string; v: ReactNode; s?: ReactNode; cls?: string; lead?: boolean }) {
  return (
    <div className={lead ? 'lead' : ''}>
      <div className="lbl">{k}</div>
      <div className={`v ${cls ?? ''}`}>{v}</div>
      {s != null && <div className="s">{s}</div>}
    </div>
  )
}

export function NeedWallet({ what }: { what: string }) {
  return (
    <div className="page">
      <div className="empty boxed">
        <p>
          Connect a wallet to see {what}, or add <b>?view=0x…</b> to the address to look at any account.
        </p>
        <button className="btn" onClick={connect}>
          Connect wallet
        </button>
      </div>
    </div>
  )
}

export function Stats({ market }: { market: Market | null }) {
  const w = useWallet()
  const proto = useProtocol()
  const [view, setView] = useState<'farm' | 'paper'>(() => (w.address ? 'farm' : 'paper'))
  return (
    <div className="page">
      <div className="pagehead">
        <h1 className="grow">Stats</h1>
        <div className="seg page-switch" role="tablist" aria-label="Stats view">
          <button
            role="tab"
            aria-selected={view === 'farm'}
            className={view === 'farm' ? 'on' : ''}
            onClick={() => setView('farm')}
          >
            Your farm
          </button>
          <button
            role="tab"
            aria-selected={view === 'paper'}
            className={view === 'paper' ? 'on' : ''}
            onClick={() => setView('paper')}
          >
            Papertrade
          </button>
        </div>
      </div>
      {view === 'paper' ? (
        <PaperView p={proto} market={market} />
      ) : !w.address ? (
        <div className="empty boxed">
          <p>
            Connect a wallet to see your farm, or add <b>?view=0x…</b> to the address to look at any account.
          </p>
          <button className="btn" onClick={connect}>
            Connect wallet
          </button>
        </div>
      ) : (
        <FarmView market={market} p={proto} />
      )}
    </div>
  )
}

function useProtocol(): Protocol | null {
  const s = usePoll<Summary>('/paper/query/protocol/summary', 30_000).data
  const h = usePoll<History>('/paper/query/protocol/history?interval=1d', 300_000).data
  return useMemo(() => (s && h?.columns ? deriveProtocol(s, h) : null), [s, h])
}

/** Cost of 1K PAPER on the Balanced setting (BTC, a 0.5% move): the yardstick for payback. */
const balancedCost = (m: Market | null) => m?.coins.BTC?.table.find((r) => r.tp === 0.005)?.costPer1k ?? 0

function PaperView({ p, market }: { p: Protocol | null; market: Market | null }) {
  if (!p) return <div className="empty boxed">Reading Papertrade's numbers…</div>
  const cost = balancedCost(market)
  const payback = paybackDays(cost, p.yieldPer1kDay)
  return (
    <>
      <div className="summary">
        <Cell
          lead
          k="PAPER per $1 lost"
          v={p.rate.toFixed(1)}
          s={
            p.lp < p.cliff
              ? 'Flat 100 until the LP passes $2M'
              : `Past the ${usdc(p.cliff)} cliff, it falls as the LP grows`
          }
        />
        <Cell
          lead
          k="Paid to stakers"
          v={usdc(p.paidLifetime)}
          cls="pos"
          s={`${usdc(p.paidLastDay)} yesterday · ${usdc(p.paidToday)} so far today`}
        />
        <Cell lead k="Staking yield" v={`$${p.yieldPer1kDay.toFixed(2)}`} s="A day per 1K staked PAPER, last 3 days" />
        <Cell
          lead
          k="Payback"
          v={isFinite(payback) ? `${payback.toFixed(0)} days` : '—'}
          s={cost ? `To earn back ${usd(cost)} per 1K PAPER (Balanced, BTC)` : undefined}
        />
      </div>
      <div className="summary">
        <Cell
          k="LP"
          v={usdc(p.lp)}
          s={
            <span className="row">
              ${compact(p.cliff / 1e6)}M cliff · ${compact(p.cap / 1e6)}M staker cap
              <span className="gauge" aria-hidden="true">
                <i style={{ width: `${Math.min(100, (p.lp / (p.cap * 1.2)) * 100)}%` }} />
                <u style={{ left: `${(p.cliff / (p.cap * 1.2)) * 100}%` }} />
                <u style={{ left: `${100 / 1.2}%` }} />
              </span>
            </span>
          }
        />
        <Cell
          k="Traders' net PnL"
          v={(p.traderPnl > 0 ? '+' : '') + usdc(p.traderPnl)}
          cls={tone(p.traderPnl)}
          s="What the LP and stakers took in"
        />
        <Cell
          k="Volume"
          v={usdc(p.volume)}
          s={market ? `${usdc(Object.values(market.coins).reduce((x, c) => x + c.volume24h, 0))} in 24 h` : undefined}
        />
        <Cell k="Traders" v={p.users.toLocaleString()} s={`${compact(p.trades)} trades`} />
        <Cell k="PAPER supply" v={compact(p.supply)} s={`${pct(p.staked / p.supply, 1)} staked`} />
        <Cell k="Total value locked" v={usdc(p.tvl)} s={`${usdc(p.margin)} in open positions`} />
        <Cell
          k="Open positions"
          v={p.open.toLocaleString()}
          s={p.queue > 0 ? `${usdc(p.queue)} in the payout queue` : 'Payout queue empty'}
        />
        <Cell k="Liquidated" v={usdc(p.liquidated)} s="Notional busted, all time" />
      </div>
      <div className="section grid2">
        <div>
          <h2>Paid to stakers, by day</h2>
          <div className="chartcard">
            <Bars data={p.days.map((d) => ({ t: d.t, v: d.paid }))} fmt={usdc} />
          </div>
        </div>
        <div>
          <h2>PAPER minted, by day</h2>
          <div className="chartcard">
            <Bars data={p.days.map((d) => ({ t: d.t, v: d.minted }))} fmt={compact} />
          </div>
        </div>
      </div>
      <div className="section">
        <h2>Mint curve</h2>
        <div className="chartcard">
          <MintCurve p={p} />
        </div>
        <p className="chartnote">
          Losses mint 100 PAPER per $1 until the LP first passes $2M. After that, the rate falls as the LP's gains past
          the cliff add up ({usdc(p.tail)} so far). The curve never comes back up, so earlier PAPER is cheaper PAPER.
        </p>
      </div>
    </>
  )
}

function FarmView({ market, p }: { market: Market | null; p: Protocol | null }) {
  const w = useWallet()
  const { account: a } = useStream()
  const { mids } = usePrices()
  const st = usePoll<S>(`/api/stats/${w.address}`, 30_000)
  const [all, setAll] = useState(false)
  const tr = usePoll<{ accRewardPerShareRaw: string }>('/paper/state/trading', 30_000).data
  const s = st.data
  const yieldNow = a ? pendingYield(a, tr?.accRewardPerShareRaw) : 0
  const cost = s ? -s.pnl : 0
  const claimed = a?.lifetime.claimed ?? s?.claimed ?? 0
  const afterYield = (s?.pnl ?? 0) + claimed + yieldNow
  const share = market && market.paperStaked > 0 && a ? a.paper.staked / market.paperStaked : 0

  const upnl = a
    ? Object.values(a.positions).reduce(
        (x, q) =>
          x +
          (q.long ? priceOf(mids, q.coin) / q.entry - 1 : 1 - priceOf(mids, q.coin) / q.entry) * q.margin * q.leverage,
        0,
      )
    : 0
  const perDay = a && p ? (a.paper.staked / 1000) * p.yieldPer1kDay : 0
  const payback = perDay > 0 && cost > 0 ? cost / perDay : Infinity
  return (
    <>
      {a && (
        <>
          <h2 className="sub">Account</h2>
          <div className="summary">
            <Cell
              lead
              k="Equity"
              v={usd(a.balance + a.locked + a.queued + upnl)}
              s={`${usd(a.avail)} free · ${usd(a.locked)} in positions`}
            />
            <Cell
              lead
              k="Net deposits"
              v={usd(a.lifetime.deposited - a.lifetime.withdrawn)}
              s={`${usd(a.lifetime.deposited)} in · ${usd(a.lifetime.withdrawn)} out`}
            />
            <Cell
              lead
              k="PAPER held"
              v={compact(a.paper.balance + a.paper.staked)}
              s={`${compact(a.paper.staked)} staked${share ? ` · ${(share * 100).toFixed(4)}% of all stake` : ''}`}
            />
            <Cell
              lead
              k="Earning now"
              v={`${usd(perDay)} / day`}
              cls="pos"
              s={
                isFinite(payback)
                  ? `Pays back your net cost in about ${payback.toFixed(0)} days`
                  : 'Stake PAPER to earn USDC'
              }
            />
          </div>
          <h2 className="sub">Farming</h2>
        </>
      )}
      {s && (
        <div className="meta">
          {s.closes.toLocaleString()} settled positions · updated {when(s.at)}
        </div>
      )}
      {st.error && !s && <div className="alert bad">{st.error}</div>}
      {!s && !st.error && <div className="empty boxed">Reading your trade history from Papertrade…</div>}
      {s && (
        <>
          <div className="summary">
            <Cell
              lead
              k="Cost per 1K PAPER"
              v={s.paper ? usd(s.costPer1k) : '—'}
              s={market ? `Mint rate now ${market.rate.toFixed(1)} PAPER per $1 lost` : undefined}
            />
            <Cell
              lead
              k="PAPER minted"
              v={compact(s.paper)}
              cls="pos"
              s={`${s.closes ? compact(s.paper / s.closes) : 0} per settled position`}
            />
            <Cell
              lead
              k="Net trading cost"
              v={usd(cost)}
              cls={cost > 0 ? 'neg' : 'pos'}
              s={`Realised PnL ${signed(s.pnl)}`}
            />
            <Cell lead k="Staking yield" v={usd(claimed + yieldNow)} cls="pos" s={`${usd(yieldNow)} to claim`} />
            <Cell k="Net after yield" v={signed(afterYield)} cls={tone(afterYield)} s="Trading result plus yield" />
            <Cell
              k="Volume"
              v={'$' + compact(a?.lifetime.traded ?? s.volume)}
              s={s.pairs ? `${s.pairs} pairs closed in one intent` : 'Both legs, both coins'}
            />
            <Cell
              k="Positions closed"
              v={s.closes.toLocaleString()}
              s={`${s.wins} won · ${s.losses} lost · ${s.liquidations} busted`}
            />
            <Cell k="Win fees paid" v={usd(a?.lifetime.feesPaid ?? s.fees)} s="2% of what winning legs kept" />
          </div>
          {s.truncated && (
            <div className="alert spaced">History is longer than 15,000 trades; the oldest are not counted.</div>
          )}

          <div className="section">
            <h2>
              PAPER against cost
              <span className="grow" />
              <span className="legend">
                <span>
                  <i className="k-pos" />
                  PAPER minted
                </span>
                <span>
                  <i className="k-neg" />
                  Cumulative cost
                </span>
              </span>
            </h2>
            <div className="chartcard">
              <Curve pts={s.curve} />
            </div>
          </div>

          <div className="section split">
            <div>
              <h2>
                By day <span className="muted">UTC</span>
              </h2>
              <div className="ttable scroll-x">
                <table className="t">
                  <thead>
                    <tr>
                      <th>Day</th>
                      <th className="r">Closes</th>
                      <th className="r">Net</th>
                      <th className="r">PAPER</th>
                      <th className="r">Cost / 1K</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.days.slice(0, 30).map((d) => (
                      <tr key={d.day}>
                        <td>{day(Date.parse(d.day))}</td>
                        <td className="r">{d.closes}</td>
                        <td className={`r ${tone(d.pnl)}`}>{signed(d.pnl)}</td>
                        <td className="r">{compact(d.paper)}</td>
                        <td className="r strong">{d.paper > 0 ? usd((-d.pnl / d.paper) * 1000) : '—'}</td>
                      </tr>
                    ))}
                    {!s.days.length && (
                      <tr>
                        <td colSpan={5} className="muted">
                          Nothing settled yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            <div>
              <h2>
                Settled positions{' '}
                <span className="muted">latest {all ? s.recent.length : Math.min(20, s.recent.length)}</span>
              </h2>
              <div className="ttable scroll-x">
                <table className="t">
                  <thead>
                    <tr>
                      <th>Closed (UTC)</th>
                      <th>Position</th>
                      <th className="r">Size</th>
                      <th className="r">Entry → exit</th>
                      <th className="r">PnL</th>
                      <th className="r">PAPER</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.recent.slice(0, all ? 100 : 20).map((t) => (
                      <tr key={t.positionId}>
                        <td>
                          <a
                            className="linkbtn muted"
                            href={`https://hyperevmscan.io/tx/${t.tx}`}
                            target="_blank"
                            rel="noreferrer"
                            title="Open the transaction"
                          >
                            {whenUTC(t.closedAt)}
                          </a>
                        </td>
                        <td>
                          <b>{t.coin}</b>{' '}
                          <span className={`sidetag ${t.long ? '' : 'short'}`}>
                            {t.leverage}× {t.long ? 'long' : 'short'}
                          </span>
                          {t.liquidated && <span className="sidetag bad">busted</span>}
                        </td>
                        <td className="r">{usd(t.margin * t.leverage, 0)}</td>
                        <td className="r">
                          {px(t.entry)} <span className="muted">→</span> {px(t.exit)}
                        </td>
                        <td className={`r strong ${tone(t.pnl)}`}>{signed(t.pnl)}</td>
                        <td className="r">{t.paper ? compact(t.paper) : <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {s.recent.length > 20 && (
                <div className="tablefoot">
                  <span className="small muted">
                    {all ? `Showing all ${s.recent.length}` : `20 of ${s.recent.length}`}
                  </span>
                  <button className="linkbtn" onClick={() => setAll(!all)}>
                    {all ? 'Show fewer' : 'Show all'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </>
  )
}

/** Daily bars, drawn in CSS so labels stay at text size. */
function Bars({ data, fmt }: { data: { t: number; v: number }[]; fmt: (v: number) => string }) {
  if (!data.length) return <div className="empty">No complete days yet.</div>
  const max = Math.max(...data.map((d) => d.v), 1)
  return (
    <div className="bars" role="img" aria-label={data.map((d) => `${day(d.t)}: ${fmt(d.v)}`).join(', ')}>
      {data.map((d) => (
        <div key={d.t} className="bar" title={`${day(d.t)}: ${fmt(d.v)}`}>
          <span className="bv">{fmt(d.v)}</span>
          <i style={{ height: `${Math.max(2, (d.v / max) * 100)}%` }} />
          <span className="bt">{day(d.t)}</span>
        </div>
      ))}
    </div>
  )
}

/** PAPER per $1 lost against the LP's gains past the cliff, with where Papertrade is now. */
function MintCurve({ p }: { p: Protocol }) {
  const S = 120e6,
    flat = 100
  const maxH = Math.max(2 * p.tail, 60e6)
  const rate = (h: number) => flat * (S / (S + h)) ** 2
  const W = 1000,
    H = 200
  const pts = Array.from({ length: 61 }, (_, i) => {
    const h = (maxH * i) / 60
    return `${i ? 'L' : 'M'}${((h / maxH) * W).toFixed(1)},${(H - (rate(h) / flat) * (H - 10)).toFixed(1)}`
  }).join('')
  const nowX = p.lp < p.cliff ? 0 : (p.tail / maxH) * 100
  const nowY = (1 - ((rate(p.lp < p.cliff ? 0 : p.tail) / flat) * (H - 10)) / H) * 100
  return (
    <div className="mint">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <path d={pts + `L${W},${H}L0,${H}Z`} style={{ fill: 'rgb(var(--pos-rgb) / 0.08)' }} />
        <path d={pts} fill="none" style={{ stroke: 'var(--pos)' }} strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      {/* placed against the plot, which ends above the axis row */}
      <span className="mdot" style={{ left: `${nowX}%`, top: `calc((100% - var(--s6)) * ${nowY / 100})` }} />
      <span
        className="mlabel"
        style={{ left: `${Math.min(80, nowX)}%`, top: `calc((100% - var(--s6)) * ${nowY / 100} - var(--s8))` }}
      >
        <b>{p.rate.toFixed(1)} PAPER / $</b> now
      </span>
      <span className="axis">
        <span>100 / $ at the cliff</span>
        <span>{usdc(maxH)} of LP gains past it</span>
      </span>
    </div>
  )
}
