import { type Account } from '../../lib/account.ts'
import { type Market } from '../../lib/api.ts'
import { type Farm, type PairView, findPairs } from '../../lib/pairs.ts'
import { type CoinName } from '../../lib/paper.ts'

export const COINS: CoinName[] = ['BTC', 'ETH']

export type Ctx = {
  a: Account | null
  user: string
  market: Market | null
  active: PairView[]
  done: PairView[]
  found: ReturnType<typeof findPairs>
  farms: Farm[]
  coin: CoinName
  setCoin: (c: CoinName) => void
  connecting: boolean
}
