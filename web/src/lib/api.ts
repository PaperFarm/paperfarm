// Our Go server's API.
import { useEffect, useState } from 'react'
import type { Cycle, Impact, Mint } from './paper.ts'

export type CoinInfo = {
  id: number
  coin: string
  openable: boolean
  maxLeverage: number
  maxNotional: number
  impact: Impact
  longOi: number
  shortOi: number
  longCap: number
  shortCap: number
  volume24h: number
  table: (Cycle & { tp: number })[]
}
export type Market = {
  at: number
  tradingPaused: boolean
  paused: string[]
  minMargin: number
  minNotional: number
  minStake: number
  netOiCap: number
  coins: Record<string, CoinInfo>
  mint: Mint
  rate: number
  lpCash: number
  queueTotal: number
  queueCount: number
  paperSupply: number
  paperStaked: number
  tvl: number
  openPositions: number
}
export type Trade = {
  positionId: string
  coin: string
  long: boolean
  margin: number
  leverage: number
  entry: number
  exit: number
  pnl: number
  fee: number
  paper: number
  liquidated: boolean
  openedAt: number
  closedAt: number
  tx: string
}
export type Stats = {
  address: string
  closes: number
  liquidations: number
  wins: number
  losses: number
  pairs: number
  volume: number
  pnl: number
  fees: number
  paper: number
  costPer1k: number
  days: { day: string; pnl: number; paper: number; volume: number; closes: number }[]
  curve: { t: number; paper: number; cost: number }[]
  recent: Trade[]
  truncated: boolean
  deposited: number
  withdrawn: number
  claimed: number
  at: number
}

/** GETs url now and every `every` ms; keeps the last good value through errors. */
export function usePoll<T>(url: string | null, every: number): { data: T | null; error: string; reload: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!url) {
      setData(null)
      return
    }
    let live = true
    const load = () =>
      fetch(url)
        .then(async (r) => {
          const j = await r.json()
          if (!r.ok) throw new Error(j.error ?? `http ${r.status}`)
          if (live) {
            setData(j)
            setError('')
          }
        })
        .catch((e) => live && setError(String(e.message ?? e)))
    load()
    const t = setInterval(load, every)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [url, every, n])
  return { data, error, reload: () => setN(n + 1) }
}

export const useMarket = () => usePoll<Market>('/api/market', 10_000)

/** The largest leg a pair can open now, as Papertrade's order form sizes it: each side's room is the least of
 * the max position, what is left under that side's open-interest cap, and what the net cap lets it grow to. */
export function pairRoom(c: CoinInfo, netCap: number, mid: number): number {
  const side = (oi: number, other: number, cap: number) => {
    let limit = cap > 0 ? cap : Infinity
    if (netCap > 0 && mid > 0) limit = Math.min(limit, other + netCap / mid)
    return Math.min(
      c.maxNotional > 0 ? c.maxNotional : Infinity,
      mid > 0 && limit < Infinity ? Math.max(0, limit - oi) * mid : Infinity,
    )
  }
  return Math.min(side(c.longOi, c.shortOi, c.longCap), side(c.shortOi, c.longOi, c.shortCap))
}
