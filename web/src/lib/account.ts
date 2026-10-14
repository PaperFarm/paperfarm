// The live account: Papertrade's /state/user/live stream (through our proxy), a snapshot then patches.
import { useSyncExternalStore } from 'react'
import { fromRaw, parseOp, parsePosition, type Op, type Position } from './paper.ts'

export type Closed = {
  id: string
  long: boolean
  margin: number
  leverage: number
  liquidated: boolean
  pnl: number
  paper: number
  at: number
}

export type Account = {
  rev: number
  chainTime: number
  sessions: Record<string, number> // session key -> expiry (unix s)
  balance: number
  locked: number
  avail: number
  availQueued: number
  queued: number
  paper: {
    balance: number
    staked: number
    pendingBase: bigint
    rewardDebt: bigint
    stakedRaw: bigint
    balanceRaw: bigint
  }
  lifetime: {
    deposited: number
    withdrawn: number
    realizedPnl: number
    feesPaid: number
    traded: number
    claimed: number
  }
  positions: Record<string, Position>
  ops: Record<string, Op>
  outcomes: Record<string, string> // intent id -> succeeded / failed / ... (this session only)
  closed: Record<string, Closed> // positions settled while we watched
}

export type StreamState = {
  status: 'off' | 'connecting' | 'live' | 'stale'
  account: Account | null
  at: number
  error?: string
}

type Frame = Record<string, any>

const big = (s: unknown) => {
  try {
    return BigInt(String(s ?? '0'))
  } catch {
    return 0n
  }
}

function merge(a: Account, s: Frame) {
  if (s.indexedThroughTimestamp != null) a.chainTime = s.indexedThroughTimestamp
  if (s.sessionKeys)
    a.sessions = Object.fromEntries((s.sessionKeys as [string, string][]).map(([k, e]) => [k.toLowerCase(), Number(e)]))
  if (s.balance != null) a.balance = fromRaw(s.balance)
  if (s.locked != null) a.locked = fromRaw(s.locked)
  if (s.queued != null) a.queued = fromRaw(s.queued)
  if (s.funds) {
    a.avail = fromRaw(s.funds.availableBalance)
    a.availQueued = fromRaw(s.funds.availableQueued)
  }
  if (s.paper)
    a.paper = {
      balance: fromRaw(s.paper.balance),
      staked: fromRaw(s.paper.staked),
      pendingBase: big(s.paper.pendingBase),
      rewardDebt: big(s.paper.rewardDebt),
      stakedRaw: big(s.paper.staked),
      balanceRaw: big(s.paper.balance),
    }
}

function life(a: Account, l: Frame | undefined) {
  if (!l) return
  a.lifetime = {
    deposited: fromRaw(l.depositedRaw),
    withdrawn: fromRaw(l.withdrawnRaw),
    realizedPnl: fromRaw(l.realizedPnlRaw),
    feesPaid: fromRaw(l.feesPaidRaw),
    traded: fromRaw(l.tradedNotionalRaw),
    claimed: fromRaw(l.paperRewardsClaimedRaw),
  }
}

/** Applies one wallet frame. Returns null when a patch does not follow `prev` (reconnect for a fresh snapshot). */
export function apply(prev: Account | null, f: Frame): Account | null {
  if (f.baseAccountRevision == null) {
    const a: Account = {
      rev: f.accountRevision,
      chainTime: 0,
      sessions: {},
      balance: 0,
      locked: 0,
      avail: 0,
      availQueued: 0,
      queued: 0,
      paper: { balance: 0, staked: 0, pendingBase: 0n, rewardDebt: 0n, stakedRaw: 0n, balanceRaw: 0n },
      lifetime: { deposited: 0, withdrawn: 0, realizedPnl: 0, feesPaid: 0, traded: 0, claimed: 0 },
      positions: {},
      ops: {},
      outcomes: prev?.outcomes ?? {},
      closed: prev?.closed ?? {},
    }
    merge(a, f)
    life(a, f.lifetime)
    for (const r of f.openPositions ?? []) {
      const p = parsePosition(r)
      if (p) a.positions[p.id] = p
    }
    for (const r of f.operations ?? []) {
      const o = parseOp(r)
      if (o) a.ops[o.id] = o
    }
    return a
  }
  if (!prev || Number(f.baseAccountRevision) !== prev.rev) return null
  const a: Account = {
    ...prev,
    rev: f.accountRevision,
    positions: { ...prev.positions },
    ops: { ...prev.ops },
    outcomes: { ...prev.outcomes },
    closed: { ...prev.closed },
  }
  if (f.state) merge(a, f.state)
  life(a, f.lifetime)
  for (const id of f.removedPositionIds ?? []) delete a.positions[id]
  for (const r of f.addedPositions ?? []) {
    const p = parsePosition(r)
    if (p) a.positions[p.id] = p
  }
  for (const id of f.removedOperationIds ?? []) delete a.ops[String(id).toLowerCase()]
  for (const r of f.addedOperations ?? []) {
    const o = parseOp(r)
    if (o) a.ops[o.id] = o
  }
  for (const [id, outcome] of (f.intentOutcomes ?? []) as [string, string][]) a.outcomes[id.toLowerCase()] = outcome
  for (const c of (f.closedPositions ?? []) as unknown[][]) {
    // [id, instrument, isLong, margin, leverage, liquidated, netPnl, paperMinted]
    if (c.length < 8) continue
    const id = String(c[0])
    a.closed[id] = {
      id,
      long: !!c[2],
      margin: fromRaw(c[3] as string),
      leverage: Number(c[4]),
      liquidated: !!c[5],
      pnl: c[5] ? -fromRaw(c[3] as string) : fromRaw(c[6] as string),
      paper: fromRaw(c[7] as string),
      at: Date.now(),
    }
  }
  return a
}

/** One wallet's stream. Reconnects with backoff; a patch out of order reconnects for a fresh snapshot. */
export class AccountStream {
  state: StreamState = { status: 'off', account: null, at: 0 }
  private es: EventSource | null = null
  private subs = new Set<() => void>()
  private addr = ''
  private retry = 1000
  private timer = 0
  private watchdog = 0

  subscribe = (f: () => void) => {
    this.subs.add(f)
    return () => {
      this.subs.delete(f)
    }
  }
  get = () => this.state
  private set(s: Partial<StreamState>) {
    this.state = { ...this.state, ...s }
    this.subs.forEach((f) => f())
  }

  watch(addr: string) {
    addr = addr.toLowerCase()
    if (addr === this.addr) return
    this.stop()
    this.addr = addr
    if (addr) this.open()
  }

  stop() {
    this.es?.close()
    this.es = null
    clearTimeout(this.timer)
    clearInterval(this.watchdog)
    this.addr = ''
    this.set({ status: 'off', account: null, at: 0 })
  }

  private open() {
    const addr = this.addr
    this.set({ status: this.state.account ? 'stale' : 'connecting' })
    const es = new EventSource(`/paper/state/user/live?wallet=${addr}`)
    this.es = es
    let last = Date.now()
    const beat = () => {
      last = Date.now()
    }
    es.addEventListener('liveness', beat)
    es.addEventListener('heartbeat', beat)
    es.addEventListener('wallet', (e: MessageEvent) => {
      beat()
      let f: Frame
      try {
        f = JSON.parse(e.data)
      } catch {
        return
      }
      if (f.address && f.address.toLowerCase() !== addr) return
      const next = apply(this.state.account, f)
      if (!next) {
        this.reconnect()
        return
      }
      this.retry = 1000
      this.set({ status: 'live', account: next, at: Date.now(), error: undefined })
    })
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) this.reconnect()
      else this.set({ status: 'stale' })
    }
    clearInterval(this.watchdog)
    this.watchdog = window.setInterval(() => {
      if (Date.now() - last > 45_000) this.reconnect()
    }, 5000) // heartbeats come every 10 s
  }

  private reconnect() {
    this.es?.close()
    this.es = null
    clearInterval(this.watchdog)
    clearTimeout(this.timer)
    this.set({ status: 'stale' })
    this.timer = window.setTimeout(() => {
      if (this.addr) this.open()
    }, this.retry)
    this.retry = Math.min(this.retry * 2, 30_000)
  }
}

export const stream = new AccountStream()
export const useStream = () => useSyncExternalStore(stream.subscribe, stream.get)
