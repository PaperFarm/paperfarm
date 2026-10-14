// Pairs and farms as the server records them, read against the live account for display. The server's
// engine (server/farm.go) makes every decision; this file only shows where each pair stands.
import type { Account, Closed } from './account.ts'
import type { CoinName, Op, Position } from './paper.ts'

export type Side = 'long' | 'short'

export type PairRec = {
  id: string
  coin: CoinName
  notional: number // per leg
  lev: number
  tp: number // fraction of price
  auto: boolean
  createdAt: number
  deadline: number // ms: an open not run by then never runs
  intents: Partial<Record<Side, string>>
  legs: Partial<Record<Side, string>> // position ids, once seen
  close?: { id: string; at: number; ids: string[] }
  found?: boolean // positions opened elsewhere, adopted
  error?: string
  archived?: boolean
  farm?: string
  counted?: boolean
}

export type Farm = {
  id: string
  coin: CoinName
  notional: number
  lev: number
  tp: number
  slots: number
  running: boolean
  createdAt: number
  opened: number
  closed: number
  paper: number
  pnl: number
  lastOpen: number
  backoffUntil: number
  fails: number
  status?: string
}

export type LegStatus = 'none' | 'sending' | 'queued' | 'open' | 'failed' | 'closed'
export type Leg = { status: LegStatus; pos?: Position; op?: Op; closed?: Closed; why?: string }
export type PairState = 'sending' | 'queued' | 'partial' | 'open' | 'broken' | 'closing' | 'closed' | 'failed'
export type PairView = { rec: PairRec; state: PairState; long: Leg; short: Leg; entry: number }

export function leg(rec: PairRec, side: Side, a: Account, now: number): Leg {
  const pid = rec.legs[side],
    iid = rec.intents[side]
  if (pid)
    return a.positions[pid] ? { status: 'open', pos: a.positions[pid] } : { status: 'closed', closed: a.closed[pid] }
  if (!iid) return { status: rec.error ? 'failed' : 'none', why: rec.error }
  const pos = Object.values(a.positions).find((p) => p.intent === iid)
  if (pos) return { status: 'open', pos }
  if (a.ops[iid]) return { status: 'queued', op: a.ops[iid] }
  const out = a.outcomes[iid]
  if (out && out !== 'succeeded') return { status: 'failed', why: out }
  if (out === 'succeeded') return { status: 'closed' } // opened and already gone (a fast liquidation)
  if (now > rec.deadline + 60_000) return { status: 'failed', why: 'expired' }
  return { status: 'sending' }
}

export function derive(rec: PairRec, a: Account, now: number): PairView {
  const l = leg(rec, 'long', a, now),
    s = leg(rec, 'short', a, now)
  const st = [l.status, s.status]
  const open = st.filter((x) => x === 'open').length
  const waiting = st.filter((x) => x === 'queued' || x === 'sending').length
  const dead = st.filter((x) => x === 'failed' || x === 'none').length
  let state: PairState
  if (open === 2) state = 'open'
  else if (open === 0 && waiting === 0) state = st.includes('closed') ? 'closed' : 'failed'
  else if (waiting && !dead)
    state = open ? 'partial' : st.includes('sending') && !st.includes('queued') ? 'sending' : 'queued'
  else state = 'broken' // one side open or waiting, the other dead or gone
  if (rec.close && open > 0 && (state === 'open' || state === 'broken')) state = 'closing'
  const ps = [l.pos, s.pos].filter(Boolean) as Position[]
  return { rec, state, long: l, short: s, entry: ps.length ? ps.reduce((x, p) => x + p.entry, 0) / ps.length : 0 }
}

/** Pairs up positions no record owns: same coin, sizes within 10%, closest size first, then closest in time. */
export function findPairs(ps: Position[]): { pairs: [Position, Position][]; single: Position[] } {
  const cands: { l: Position; s: Position; d: number; gap: number }[] = []
  for (const l of ps)
    for (const s of ps) {
      if (!l.long || s.long || l.coin !== s.coin) continue
      const nl = l.margin * l.leverage,
        ns = s.margin * s.leverage
      const d = Math.abs(nl - ns) / Math.max(nl, ns)
      if (d <= 0.1) cands.push({ l, s, d: Math.round(d * 1000), gap: Math.abs(l.openedAt - s.openedAt) })
    }
  cands.sort((x, y) => x.d - y.d || x.gap - y.gap)
  const used = new Set<string>(),
    pairs: [Position, Position][] = []
  for (const c of cands)
    if (!used.has(c.l.id) && !used.has(c.s.id)) {
      used.add(c.l.id)
      used.add(c.s.id)
      pairs.push([c.l, c.s])
    }
  return { pairs, single: ps.filter((p) => !used.has(p.id)) }
}

/** Net exposure per coin over every open position: long notional minus short notional. */
export function exposure(ps: Position[]): Record<string, { net: number; gross: number }> {
  const out: Record<string, { net: number; gross: number }> = {}
  for (const p of ps) {
    const n = p.margin * p.leverage,
      e = (out[p.coin] ??= { net: 0, gross: 0 })
    e.net += p.long ? n : -n
    e.gross += n
  }
  return out
}
