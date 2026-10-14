import type { Layout } from 'react-grid-layout'
import { TIMEFRAMES, type Timeframe } from '../../components/PriceChart.tsx'
import { type PairView } from '../../lib/pairs.ts'
import { type CoinName } from '../../lib/paper.ts'
import { store } from '../../lib/storage.ts'

// ---- the board: windows the user arranges ----

// What a window can hold. Chart and pairs follow the window's coin and picked farms.
export type Block = 'chart' | 'pairs' | 'farms' | 'positions' | 'market' | 'settled'
export const BLOCKS: [Block, string][] = [
  ['chart', 'Chart'],
  ['pairs', 'Pairs'],
  ['farms', 'Farms'],
  ['positions', 'Positions'],
  ['market', 'Papertrade'],
  ['settled', 'Recently settled'],
]
export type Item = { i: string; blocks: Block[]; coin: CoinName; sel: string[] | null; tf: Timeframe | number } // i 'new' is the New farm window; sel: farm ids or hand-opened pair ids, null for all
export type BoardState = { items: Item[]; layout: Layout[] }
export const BOARD_KEY = 'pf:board2'
export const win = (i: string, blocks: Block[]): Item => ({ i, blocks, coin: 'BTC', sel: null, tf: 'tick' })
export const tfOf = (it: Item): Timeframe =>
  typeof it.tf === 'string' && TIMEFRAMES.some(([k]) => k === it.tf) ? it.tf : 'tick' // older layouts saved minutes
export const DEFAULT_BOARD: BoardState = {
  items: [
    win('w1', ['chart', 'pairs']),
    win('new', []),
    win('w2', ['farms']),
    win('w3', ['positions']),
    win('w4', ['market', 'settled']),
  ],
  layout: [
    { i: 'w1', x: 0, y: 0, w: 8, h: 13, minW: 3, minH: 4 },
    { i: 'new', x: 8, y: 0, w: 4, h: 17, minW: 3, minH: 6 },
    { i: 'w2', x: 0, y: 13, w: 8, h: 6, minW: 3, minH: 3 },
    { i: 'w3', x: 0, y: 19, w: 8, h: 10, minW: 3, minH: 3 },
    { i: 'w4', x: 8, y: 19, w: 4, h: 14, minW: 3, minH: 3 },
  ],
}
export const validBoard = (b: unknown): b is BoardState => {
  const x = b as BoardState
  return Array.isArray(x?.items) && Array.isArray(x?.layout) && x.items.some((it) => it.i === 'new')
}
export function readBoard(): BoardState {
  try {
    const b = JSON.parse(store(BOARD_KEY, ''))
    if (validBoard(b)) return b
  } catch {
    /* first visit */
  }
  return DEFAULT_BOARD
}

/** Where a pair belongs in a window: its farm, or itself when opened by hand. */
export const sourceOf = (v: PairView) => v.rec.farm ?? v.rec.id
