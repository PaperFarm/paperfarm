// node src/lib/pairs.check.ts -- where each pair stands, read against account states. The engine's
// decisions are tested on the server (server/farm_test.go).
import { apply, type Account } from './account.ts'
import { derive, exposure, findPairs, type PairRec } from './pairs.ts'
import { closeNow, cycle } from './paper.ts'

let bad = 0
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    bad++
    console.error(`✗ ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
  } else console.log(`✓ ${name}`)
}

const L = '0x' + 'a'.repeat(64),
  S = '0x' + 'b'.repeat(64),
  C = '0x' + 'c'.repeat(64)
const pos = (id: string, long: boolean, intent: string, entry = 834995) => [
  id,
  0,
  long,
  false,
  String(entry),
  '100000000000000000000',
  10,
  long ? '760000' : '910000',
  1791969000000,
  intent,
]
const op = (id: string) => [
  id,
  'openPosition',
  0,
  true,
  false,
  '100000000000000000000',
  10,
  1791969000000,
  '1791969300',
  null,
]

const snap = (positions: unknown[], ops: unknown[]): Account =>
  apply(null, {
    accountRevision: 1,
    funds: { availableBalance: '1000000000000000000000', availableQueued: '0' },
    openPositions: positions,
    operations: ops,
  })!
const rec = (): PairRec => ({
  id: 'x',
  coin: 'BTC',
  notional: 1000,
  lev: 10,
  tp: 0.005,
  auto: true,
  createdAt: 0,
  deadline: 300_000,
  intents: { long: L, short: S },
  legs: {},
})
const now = 100_000

eq('both queued', derive(rec(), snap([], [op(L), op(S)]), now).state, 'queued')
eq('one filled', derive(rec(), snap([pos('1', true, L)], [op(S)]), now).state, 'partial')
const a = snap([pos('1', true, L), pos('2', false, S)], [])
const v = derive(rec(), a, now)
eq('open, entry is the mean', [v.state, v.entry], ['open', 83499.5])
eq('expired short → broken', derive(rec(), snap([pos('1', true, L)], []), 400_000).state, 'broken')

// A patch: the close executes, both positions leave with their results.
const r = { ...rec(), legs: { long: '1', short: '2' }, close: { id: C, at: 0, ids: ['1', '2'] } }
const a2 = apply(a, {
  accountRevision: 2,
  baseAccountRevision: 1,
  removedPositionIds: ['1', '2'],
  intentOutcomes: [[C, 'succeeded']],
  closedPositions: [
    ['1', 0, true, '100000000000000000000', 10, false, '4100000000000000000', '0'],
    ['2', 0, false, '100000000000000000000', 10, false, '-5000000000000000000', '110500000000000000000'],
  ],
})!
const done = derive(r, a2, now)
eq('closed with results', [done.state, done.long.closed?.pnl, done.short.closed?.paper], ['closed', 4.1, 110.5])
eq('a patch out of order is refused', apply(a2, { accountRevision: 9, baseAccountRevision: 7 }), null)

const p = (id: string, long: boolean, margin: string, t: number) => ({
  id,
  coin: 'BTC' as const,
  long,
  useDebt: false,
  entry: 1,
  margin: Number(margin),
  leverage: 10,
  bust: 0,
  openedAt: t,
  intent: '',
})
const f = findPairs([
  p('a', true, '100', 0),
  p('b', false, '105', 50),
  p('c', false, '100', 900),
  p('d', true, '300', 0),
])
eq(
  'found pairs: equal size first',
  [f.pairs.map(([l, s]) => l.id + s.id), f.single.map((x) => x.id)],
  [['ac'], ['b', 'd']],
)
eq('exposure', exposure([p('a', true, '100', 0), p('b', false, '100', 0), p('c', true, '50', 0)]).BTC, {
  net: 500,
  gross: 2500,
})

const imp = { base: 0.1, k: 0.0001894 }
const c = cycle(imp, 22, 100_000, 10, 0.005)
eq('cycle at 10x', [Math.round(c.cost), Math.round(c.paper), c.busts], [77, 10780, false])
eq(
  'cycle at 1000x busts',
  [cycle(imp, 22, 100_000, 1000, 0.005).busts, cycle(imp, 22, 100_000, 1000, 0.005).loss],
  [true, 100],
)
const lp = {
  id: '1',
  coin: 'BTC' as const,
  long: true,
  useDebt: false,
  entry: 100,
  margin: 100,
  leverage: 10,
  bust: 0,
  openedAt: 0,
  intent: '',
}
const cn = closeNow(imp, 22, lp, { ...lp, id: '2', long: false }, 100.5)
eq(
  'close now',
  [
    Math.round(cn.longPnl * 100) / 100,
    Math.round(cn.shortPnl * 100) / 100,
    cn.cost > 0 && cn.cost < 5,
    Math.round(cn.paper),
  ],
  [5, -5, true, 108],
)
if (bad) process.exit(1)
