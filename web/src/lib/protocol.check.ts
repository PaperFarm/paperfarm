// node src/lib/protocol.check.ts -- the protocol numbers from a fixed history and summary.
import { deriveProtocol, paybackDays, type History, type Summary } from './protocol.ts'

let bad = 0
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    bad++
    console.error(`✗ ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
  } else console.log(`✓ ${name}`)
}
const D = 86_400_000,
  start = 1_000 * D
// Days 0-1 before trading; day 2 the launch lump; days 3-5 normal; day 6 in progress.
const h: History = {
  startMs: start,
  intervalMs: D,
  columns: {
    trades: [0, 0, 10, 20, 30, 40, 45],
    paperRevenue: [0, 0, 24, 2, 3, 4, 1],
    paperStaked: [0, 0, 1000, 1000, 1000, 2000, 2000],
    paperSupply: [0, 0, 1000, 1100, 1300, 2100, 2200],
    traderPnl: [0, 0, -10, -12, -15, -20, -21],
    users: [0, 1, 5, 6, 7, 8, 9],
    liquidation: [0, 0, 1, 2, 3, 4, 5],
  },
}
const r = (v: number) => (BigInt(Math.round(v * 1e6)) * 10n ** 12n).toString()
const s: Summary = {
  balances: { tvl: r(500), margin: r(50), lp: r(3e6), queue: '0' },
  activity: { volume: r(9e9), open: 7 },
  fees: { pending: '0', lifetime: r(34) },
  paper: {
    supply: r(2200),
    staked: r(2000),
    trackedLp: r(3e6),
    tailProgress: r(120e6),
    cliff: r(2e6),
    cap: r(5e6),
    rate: r(100),
    decay: r(120e6),
  },
}
const p = deriveProtocol(s, h, start + 6 * D + 1000)
eq(
  'complete trading days',
  p.days.map((d) => d.paid),
  [24, 2, 3, 4],
)
eq(
  'minted per day',
  p.days.map((d) => d.minted),
  [1000, 100, 200, 800],
)
eq('last complete day and today', [p.paidLastDay, p.paidToday], [4, 1])
eq(
  'yield over the last three days, per 1K staked',
  Math.round(p.yieldPer1kDay * 1e4) / 1e4,
  Math.round(((2 + 3 + 4) / 4000) * 1000 * 1e4) / 1e4,
)
eq('rate past the cliff: 100 × (S/(S+H))²', p.rate, 25)
eq('payback days', paybackDays(9, 2.25), 4)
eq('no yield, no payback', paybackDays(9, 0), Infinity)
if (bad) process.exit(1)
