// Prices the way Papertrade's own app reads them: Hyperliquid's top of book (`bbo`) on one websocket,
// shown as the size-weighted microprice and kept as 125 ms tick points; candles per timeframe from
// Hyperliquid's `candle` stream, seeded from a snapshot when a chart first asks; plus the 24h reference.
import { useSyncExternalStore } from 'react'

export type Candle = { t: number; o: number; h: number; l: number; c: number } // t: interval start, ms
export type Point = { t: number; p: number } // t: 125 ms bucket
export type Interval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d'
export const INTERVAL_MS: Record<Interval, number> = {
  '1m': 60e3,
  '5m': 300e3,
  '15m': 900e3,
  '1h': 3600e3,
  '4h': 14400e3,
  '1d': 86400e3,
}
type State = { mids: Record<string, number>; prevDay: Record<string, number>; at: number; live: boolean }

const COINS = ['BTC', 'ETH']
const KEEP_CANDLES = 5000 // Hyperliquid serves up to 5000 of each interval
const PAGE = 500 // candles per older page
const TICK_HISTORY_MS = 30 * 60_000 // how far back our server serves Papertrade's ticks
const KEEP_POINTS_MS = TICK_HISTORY_MS + 60_000
const series: Record<string, Candle[]> = {} // `${coin}:${interval}`
const watching = new Map<string, number>()
const points: Record<string, Point[]> = { BTC: [], ETH: [] }
const latest: Record<string, number> = {}
let state: State = { mids: {}, prevDay: {}, at: 0, live: false }
const subs = new Set<() => void>()
const tickSubs = new Set<() => void>()
let ws: WebSocket | null = null
let started = false
let flush = 0

function set(s: Partial<State>) {
  state = { ...state, ...s }
  subs.forEach((f) => f())
}
const ticked = () => tickSubs.forEach((f) => f())
const send = (method: string, sub: object) => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ method, subscription: sub }))
}

/** Puts a candle in place by its start; `older` (snapshot) data never overwrites a live one already there. */
function upsert(key: string, c: Candle, older = false) {
  const cs = series[key]
  if (!cs) return
  const last = cs[cs.length - 1]
  if (!last || c.t > last.t) cs.push(c)
  else {
    let i = cs.length - 1
    while (i > 0 && cs[i].t > c.t) i--
    if (cs[i].t === c.t) {
      if (!older) cs[i] = c
    } else if (cs[i].t < c.t) cs.splice(i + 1, 0, c)
    else cs.unshift(c)
  }
  if (cs.length > KEEP_CANDLES) cs.splice(0, cs.length - KEEP_CANDLES)
}
type Raw = { t: number; o: string; h: string; l: string; c: string; s: string; i: string }
const parse = (c: Raw): Candle => ({ t: c.t, o: +c.o, h: +c.h, l: +c.l, c: +c.c })
const info = (body: unknown) =>
  fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json())

async function seed(coin: string, interval: Interval) {
  try {
    const end = Date.now()
    const cs: Raw[] = await info({
      type: 'candleSnapshot',
      req: { coin, interval, startTime: end - PAGE * INTERVAL_MS[interval], endTime: end },
    })
    for (const c of cs) upsert(`${coin}:${interval}`, parse(c), true)
    ticked()
  } catch {
    /* the live feed fills in */
  }
}

const paging = new Set<string>(),
  exhausted = new Set<string>()
/** Loads the page of candles before the oldest one held, when a chart pans near it. */
export async function olderCandles(coin: string, interval: Interval) {
  const key = `${coin}:${interval}`,
    first = series[key]?.[0]
  if (!first || paging.has(key) || exhausted.has(key) || series[key].length >= KEEP_CANDLES) return
  paging.add(key)
  try {
    const ms = INTERVAL_MS[interval]
    const cs: Raw[] = await info({
      type: 'candleSnapshot',
      req: { coin, interval, startTime: first.t - PAGE * ms, endTime: first.t - 1 },
    })
    if (!cs.length) exhausted.add(key)
    for (const c of cs) upsert(key, parse(c), true)
    ticked()
  } catch {
    /* try again on the next pan */
  } finally {
    paging.delete(key)
  }
}
// Papertrade's own 125 ms history (through our server, which caches it), so a fresh page starts with the
// last ten minutes instead of an empty line. Live ticks already received win over history.
const MARKET_ID: Record<string, number> = { BTC: 0, ETH: 1 } // Papertrade's instrument ids
type Tile = { baseTimeMs: number; timeOffsetsMs: number[]; columns: { price: number[] } }
const tickMinutes: Record<string, Set<number>> = { BTC: new Set(), ETH: new Set() } // minutes asked for
/** Fills a coin's tick history from minute `from` up to what it already holds (never older than the server keeps). */
async function loadTicks(coin: string, from: number) {
  const now = Date.now(),
    held = points[coin][0]?.t ?? now,
    oldest = Math.ceil((now - TICK_HISTORY_MS + 60_000) / 60_000) * 60_000
  const minutes: number[] = []
  for (let m = Math.max(oldest, Math.floor(from / 60_000) * 60_000); m <= held; m += 60_000)
    if (!tickMinutes[coin].has(m)) {
      tickMinutes[coin].add(m)
      minutes.push(m)
    }
  if (!minutes.length) return
  const tiles = await Promise.all(
    minutes.map((m) =>
      fetch(`/api/ticks/${MARKET_ID[coin]}/${m}`)
        .then((r) => (r.ok ? (r.json() as Promise<Tile>) : null))
        .catch(() => null),
    ),
  )
  const got: Point[] = []
  for (const tile of tiles)
    tile?.timeOffsetsMs.forEach((o, i) => got.push({ t: tile.baseTimeMs + o, p: tile.columns.price[i] }))
  // merge in time order; a live tick already held wins over history for the same moment
  const pts = points[coin],
    have = new Set(pts.map((p) => p.t))
  pts.push(...got.filter((p) => !have.has(p.t)))
  pts.sort((a, b) => a.t - b.t)
  ticked()
}
/** Loads older ticks when a chart pans back to `t`. */
export const olderTicks = (coin: string, t: number) => {
  if (points[coin] && t < (points[coin][0]?.t ?? Infinity)) loadTicks(coin, t)
}
async function loadPrevDay() {
  try {
    const [meta, ctxs]: [{ universe: { name: string }[] }, { prevDayPx: string }[]] = await info({
      type: 'metaAndAssetCtxs',
    })
    const prevDay: Record<string, number> = {}
    meta.universe.forEach((u, i) => {
      if (COINS.includes(u.name)) prevDay[u.name] = Number(ctxs[i].prevDayPx)
    })
    set({ prevDay })
  } catch {
    /* the change badge stays empty */
  }
}

/** Keeps a coin's candles of one timeframe loaded and live while something shows them. */
export function watchCandles(coin: string, interval: Interval): () => void {
  start()
  const key = `${coin}:${interval}`,
    n = watching.get(key) ?? 0
  watching.set(key, n + 1)
  if (n === 0) {
    series[key] ??= []
    seed(coin, interval)
    send('subscribe', { type: 'candle', coin, interval })
  }
  return () => {
    const left = (watching.get(key) ?? 1) - 1
    if (left > 0) {
      watching.set(key, left)
      return
    }
    watching.delete(key)
    send('unsubscribe', { type: 'candle', coin, interval })
  }
}

// The price Papertrade shows: the mid weighted toward the side with less size, so it leans where the book will move.
function microprice(bid: { px: string; sz: string }, ask: { px: string; sz: string }) {
  const b = +bid.px,
    a = +ask.px,
    bs = +bid.sz,
    as = +ask.sz
  return bs + as > 0 ? (b * as + a * bs) / (bs + as) : (a + b) / 2
}

function connect() {
  ws = new WebSocket('wss://api.hyperliquid.xyz/ws')
  ws.onopen = () => {
    for (const coin of COINS) send('subscribe', { type: 'bbo', coin })
    for (const key of watching.keys()) {
      const [coin, interval] = key.split(':')
      send('subscribe', { type: 'candle', coin, interval })
    }
    set({ live: true })
  }
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.channel === 'candle') {
      for (const c of (Array.isArray(m.data) ? m.data : [m.data]) as Raw[]) upsert(`${c.s}:${c.i}`, parse(c))
      ticked()
      return
    }
    if (m.channel !== 'bbo') return
    const { coin, time, bbo } = m.data as { coin: string; time: number; bbo: ({ px: string; sz: string } | null)[] }
    if (!bbo[0] || !bbo[1] || !points[coin]) return
    const p = microprice(bbo[0], bbo[1]),
      t = Math.floor(time / 125) * 125,
      pts = points[coin]
    latest[coin] = p
    if (pts.at(-1)?.t === t) pts[pts.length - 1].p = p
    else pts.push({ t, p })
    while (pts.length && pts[0].t < t - KEEP_POINTS_MS) pts.shift()
    ticked() // canvases redraw on every tick
    if (!flush)
      flush = window.setTimeout(() => {
        flush = 0
        set({ mids: { ...latest }, at: Date.now() })
      }, 250) // React at most 4 times a second
  }
  ws.onclose = () => {
    set({ live: false })
    setTimeout(connect, 2000)
  }
  ws.onerror = () => ws?.close()
}

function start() {
  if (started) return
  started = true
  connect()
  loadPrevDay()
  for (const coin of COINS) loadTicks(coin, Date.now() - 10 * 60_000)
  setInterval(loadPrevDay, 5 * 60_000)
  setInterval(() => {
    if (Date.now() - state.at > 15_000 && ws?.readyState === WebSocket.OPEN) ws.close()
  }, 5000) // a silent socket is a dead one
}

export function usePrices() {
  start()
  return useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => subs.delete(f)
    },
    () => state,
  )
}

/** The live price for display (Papertrade's microprice); 0 until the first tick. */
export const priceOf = (mids: Record<string, number>, coin: string) => mids[coin] ?? latest[coin] ?? 0
/** The same, as of the very last tick, between React's throttled updates. */
export const priceNow = (coin: string) => latest[coin] ?? 0
export const getCandles = (coin: string, interval: Interval) => series[`${coin}:${interval}`] ?? []
export const getPoints = (coin: string) => points[coin] ?? []
export function onTick(f: () => void) {
  start()
  tickSubs.add(f)
  return () => {
    tickSubs.delete(f)
  }
}
