// Papertrade: intents, wire formats and the economics, as its own frontend does them (live build, 2026-10-14).
// Signing is pinned by server/internal/paper/testdata/vector.json (npm run check).
import { concat, hashTypedData, keccak256, toBytes, type Hex } from 'viem'

export const EXCHANGE = '0x6cd5661646289fb6e65ea5c032310fded797d0a2'
export const STAKING = '0xaad6c7b0cc3014fc80ffedae0ed7ce5967b0f016'
export const COINS = { BTC: 0, ETH: 1 } as const
export type CoinName = keyof typeof COINS
export const COIN_BY_ID: Record<number, CoinName> = { 0: 'BTC', 1: 'ETH' }
const PRICE_SCALE: Record<number, number> = { 0: 10, 1: 100 }

const domains = {
  exchange: { name: 'String', version: '1', chainId: 999, verifyingContract: EXCHANGE }, // the exchange's domain really is "String"
  staking: { name: 'PaperStaking', version: '1', chainId: 999, verifyingContract: STAKING },
  cancel: { name: 'PaperTrade Intent Cancel', version: '2', chainId: 999, verifyingContract: EXCHANGE },
} as const
export type DomainName = keyof typeof domains

const T = (s: string) =>
  s.split(',').map((f) => {
    const [name, type] = f.split(':')
    return { name, type }
  })
const intentTypes: Record<string, { name: string; type: string }[]> = {
  RegisterSessionKey: T('user:address,key:address,expiry:uint64,feeAddress:address,nonce:uint256,deadline:uint64'),
  OpenPosition: T(
    'user:address,instrumentId:uint32,isLong:bool,size:uint128,leverage:uint32,useDebt:bool,nonce:uint256,deadline:uint64',
  ),
  Close: T('user:address,positionIds:uint256[],nonce:uint256,deadline:uint64'),
  WithdrawToCore: T('user:address,amount:uint256,nonce:uint256,deadline:uint64'),
  Stake: T('user:address,amount:uint256,nonce:uint256,deadline:uint64'),
  Unstake: T('user:address,amount:uint256,nonce:uint256,deadline:uint64'),
  Claim: T('user:address,nonce:uint256,deadline:uint64'),
  CancelIntent: T('user:address,intentId:bytes32,deadline:uint256'),
}

export type TypedData = {
  domain: (typeof domains)[DomainName]
  types: Record<string, { name: string; type: string }[]>
  primaryType: string
  message: Record<string, unknown>
}
export type Signer = { address: string; signTypedData: (td: TypedData) => Promise<Hex> }
export type Signed = Record<string, unknown>

const ID_PREFIX = keccak256(toBytes('papertrade:intent-id:v2'))

export function randomNonce(): string {
  const b = crypto.getRandomValues(new Uint8Array(16))
  return BigInt('0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('')).toString()
}

/** Signs one intent for `user` and returns it in Papertrade's wire form plus its intent id. */
export async function signIntent(
  signer: Signer,
  dom: DomainName,
  primary: string,
  user: string,
  msg: Record<string, unknown>,
): Promise<{ signed: Signed; id: Hex }> {
  const fields = intentTypes[primary]
  const all: Record<string, unknown> = { ...msg, user }
  if (!('nonce' in all) && primary !== 'CancelIntent') all.nonce = randomNonce()
  const wire: Signed = {}
  const typed: Record<string, unknown> = {}
  for (const f of fields) {
    const v = all[f.name]
    if (v === undefined) throw new Error(`${primary}: no ${f.name}`)
    if (f.type === 'uint256[]') {
      wire[f.name] = (v as string[]).map(String)
      typed[f.name] = (v as string[]).map((x) => BigInt(x))
    } else if (f.type.startsWith('uint')) {
      wire[f.name] = String(v)
      typed[f.name] = BigInt(String(v))
    } else if (f.type === 'address' || f.type.startsWith('bytes')) {
      wire[f.name] = String(v).toLowerCase()
      typed[f.name] = String(v).toLowerCase()
    } else {
      wire[f.name] = v
      typed[f.name] = v
    }
  }
  const td: TypedData = { domain: domains[dom], types: { [primary]: fields }, primaryType: primary, message: typed }
  const digest = hashTypedData(td as never)
  const sig = await signer.signTypedData(td)
  let v = parseInt(sig.slice(130, 132), 16)
  if (v < 27) v += 27
  wire.r = '0x' + sig.slice(2, 66)
  wire.s = '0x' + sig.slice(66, 130)
  wire.v = String(v)
  return { signed: wire, id: keccak256(concat([ID_PREFIX, digest, signer.address.toLowerCase() as Hex])) }
}

/** usd at `decimals`, rounded down to the cent. */
export function usdRaw(usd: number, decimals = 18): string {
  const cents = BigInt(Math.floor(usd * 100 + 1e-6))
  return (cents * 10n ** BigInt(decimals - 2)).toString()
}

export const fromRaw = (s: string | null | undefined, decimals = 18): number => {
  if (!s) return 0
  const neg = s.startsWith('-')
  const d = (neg ? s.slice(1) : s).padStart(decimals + 1, '0')
  const v = Number(d.slice(0, d.length - decimals) + '.' + d.slice(d.length - decimals))
  return neg ? -v : v
}

// ---- the account stream's wire rows ----

export type Position = {
  id: string
  coin: CoinName
  long: boolean
  useDebt: boolean
  entry: number
  margin: number
  leverage: number
  bust: number
  openedAt: number
  intent: string
}
export type Op = {
  id: string
  action: string
  coin?: CoinName
  long?: boolean
  amount: number
  leverage: number
  at: number
  deadline: number
  closes: string[]
}

/** [id, instrument, isLong, useDebt, entry, margin, leverage, bust, openedAtMs, intentId] */
export function parsePosition(a: unknown[]): Position | null {
  const scale = PRICE_SCALE[a[1] as number]
  if (a.length < 10 || !scale) return null
  return {
    id: String(a[0]),
    coin: COIN_BY_ID[a[1] as number],
    long: !!a[2],
    useDebt: !!a[3],
    entry: Number(a[4]) / scale,
    margin: fromRaw(a[5] as string),
    leverage: Number(a[6]),
    bust: Number(a[7]) / scale,
    openedAt: Number(a[8]),
    intent: String(a[9] ?? '').toLowerCase(),
  }
}

/** [intentId, action, instrument, isLong, useDebt, amount, leverage, acceptedAtMs, deadline, closeIds] */
export function parseOp(a: unknown[]): Op | null {
  if (a.length < 8 || !a[0]) return null
  return {
    id: String(a[0]).toLowerCase(),
    action: String(a[1]),
    coin: a[2] == null ? undefined : COIN_BY_ID[a[2] as number],
    long: a[3] == null ? undefined : !!a[3],
    amount: fromRaw(a[5] as string),
    leverage: Number(a[6] ?? 0),
    at: Number(a[7]),
    deadline: Number(a[8] ?? 0) * 1000,
    closes: ((a[9] as string[]) ?? []).map(String),
  }
}

// ---- economics (docs: Asymmetric impact PnL, Mint curve, Liquidations); server/econ.go is the same ----

export type Impact = { base: number; k: number }
export type Mint = { trackedLp: number; cliff: number; flat: number; decay: number; tail: number }
const DEADBAND = 1 / 50000,
  LIQ_BUFFER = 0.0005,
  WIN_FEE = 0.02,
  LOSS_FEE = 0.02

export function winPayout(p: Impact, notional: number, move: number): number {
  const eff = Math.abs(move) - DEADBAND
  return eff <= 0 ? 0 : ((notional * eff * (1 - p.base)) / (1 + p.k / eff)) * (1 - WIN_FEE)
}
export const bustMove = (lev: number) => 1 / lev - LIQ_BUFFER

export type Cycle = {
  loss: number
  winPaid: number
  cost: number
  paper: number
  costPer1k: number
  busts: boolean
  exitMove: number
}
/** One pair round trip: two legs of `notional`, price moves `move`, both close (the survivor at once if the loser busts first). */
export function cycle(p: Impact, rate: number, notional: number, lev: number, move: number): Cycle {
  const bm = bustMove(lev)
  const busts = move >= bm
  const loss = busts ? notional / lev : notional * move
  const paper = (busts ? loss : loss * (1 - LOSS_FEE)) * rate
  const winPaid = winPayout(p, notional, busts ? bm : move)
  const cost = loss - winPaid
  return {
    loss,
    winPaid,
    cost,
    paper,
    costPer1k: paper > 0 ? (cost / paper) * 1000 : 0,
    busts,
    exitMove: busts ? bm : move,
  }
}

/** What closing a pair right now would do, at price `mid`. */
export function closeNow(p: Impact, rate: number, long: Position, short: Position, mid: number) {
  const legPnl = (pos: Position) => (pos.long ? mid / pos.entry - 1 : 1 - mid / pos.entry) * pos.margin * pos.leverage
  const lp = legPnl(long),
    sp = legPnl(short)
  const [winner, wp, lossPnl] = lp >= sp ? [long, lp, sp] : [short, sp, lp]
  const paid = wp > 0 ? winPayout(p, winner.margin * winner.leverage, wp / (winner.margin * winner.leverage)) : wp
  const loss = Math.max(0, -lossPnl)
  const paper = loss * (1 - LOSS_FEE) * rate
  const cost = loss - paid
  return {
    rawNet: lp + sp,
    net: paid - loss,
    paper,
    cost,
    costPer1k: paper > 0 ? (cost / paper) * 1000 : 0,
    longPnl: lp,
    shortPnl: sp,
  }
}
