// Papertrade as a whole: its live summary and its daily history (/query/protocol/history?interval=1d).
import { fromRaw } from './paper.ts'

export type History = { startMs: number; intervalMs: number; columns: Record<string, number[]> }
export type Summary = {
  balances: { tvl: string; margin: string; lp: string; queue: string }
  activity: { volume: string; open: number }
  fees: { pending: string; lifetime: string }
  paper: {
    supply: string
    staked: string
    trackedLp: string
    tailProgress: string
    cliff: string
    cap: string
    rate: string
    decay: string
  }
}
export type Day = { t: number; paid: number; minted: number; traderPnl: number }

export type Protocol = {
  lp: number
  cliff: number
  cap: number
  tvl: number
  margin: number
  queue: number
  rate: number // PAPER per $1 lost now
  tail: number // the mint curve's high-water mark past the cliff
  paidLifetime: number
  paidLastDay: number
  paidToday: number
  traderPnl: number
  volume: number
  trades: number
  users: number
  liquidated: number
  open: number
  supply: number
  staked: number
  yieldPer1kDay: number // USDC a day per 1,000 staked PAPER, averaged over the last complete days
  days: Day[] // complete days with trading, oldest first
}

/** Pure: the farm-relevant numbers from Papertrade's summary and daily history. */
export function deriveProtocol(s: Summary, h: History, now = Date.now()): Protocol {
  const c = h.columns,
    n = c.paperRevenue?.length ?? 0
  const at = (k: string, i: number) => c[k]?.[i] ?? 0
  // The last bucket is the day in progress; the ones before it are complete.
  const lastStart = h.startMs + (n - 1) * h.intervalMs
  const inProgress = now < lastStart + h.intervalMs
  const lastDone = inProgress ? n - 2 : n - 1
  const days: Day[] = []
  for (let i = 1; i <= lastDone; i++) {
    if (at('trades', i) === 0) continue // before trading opened
    days.push({
      t: h.startMs + i * h.intervalMs,
      paid: at('paperRevenue', i),
      minted: at('paperSupply', i) - at('paperSupply', i - 1),
      traderPnl: at('traderPnl', i) - at('traderPnl', i - 1),
    })
  }
  // Yield over the last three complete days (the launch day's lump is not representative unless it is all there is).
  const recent = days.slice(-3).filter((_, i, a) => a.length === 1 || i > 0 || days.length > 3)
  const yieldDays = recent.length ? recent : days.slice(-1)
  let rev = 0,
    staked = 0
  for (const d of yieldDays) {
    const i = Math.round((d.t - h.startMs) / h.intervalMs)
    rev += d.paid
    staked += at('paperStaked', i)
  }
  const p = s.paper
  const rate = (() => {
    const lp = fromRaw(p.trackedLp),
      cliff = fromRaw(p.cliff),
      flat = fromRaw(p.rate),
      decay = fromRaw(p.decay),
      tail = fromRaw(p.tailProgress)
    return lp < cliff || decay <= 0 ? flat : flat * (decay / (decay + tail)) ** 2
  })()
  return {
    lp: fromRaw(p.trackedLp),
    cliff: fromRaw(p.cliff),
    cap: fromRaw(p.cap),
    tvl: fromRaw(s.balances.tvl),
    margin: fromRaw(s.balances.margin),
    queue: fromRaw(s.balances.queue),
    rate,
    tail: fromRaw(p.tailProgress),
    paidLifetime: fromRaw(s.fees.lifetime),
    paidLastDay: days.at(-1)?.paid ?? 0,
    paidToday: inProgress ? at('paperRevenue', n - 1) : 0,
    traderPnl: at('traderPnl', n - 1),
    volume: fromRaw(s.activity.volume),
    trades: at('trades', n - 1),
    users: at('users', n - 1),
    liquidated: at('liquidation', n - 1),
    open: s.activity.open,
    supply: fromRaw(p.supply),
    staked: fromRaw(p.staked),
    yieldPer1kDay: staked > 0 ? (rev / staked) * 1000 : 0,
    days,
  }
}

/** Days of staking yield to earn back what 1,000 PAPER cost to mint. */
export const paybackDays = (costPer1k: number, yieldPer1kDay: number) =>
  yieldPer1kDay > 0 ? costPer1k / yieldPer1kDay : Infinity
