// The signed-in wallet's farms and pairs live on the server, which runs them around the clock with a
// trading key it holds (it can open and close positions on Papertrade, never withdraw). This module
// signs in, sets up that key, keeps the server's state fresh, and sends every action.
import { useSyncExternalStore } from 'react'
import { stream } from './account.ts'
import type { CoinName } from './paper.ts'
import { signIntent } from './paper.ts'
import type { Farm, PairRec } from './pairs.ts'
import { getWallet, refusal, signMessage, walletSigner } from './wallet.ts'

export type Me = {
  address: string | null
  key: { address: string; expiry: number; registeredUntil: number } | null
  farms: Farm[]
  board?: unknown
  pairs: PairRec[]
}

type State = { me: Me | null; loaded: boolean }
let state: State = { me: null, loaded: false }
const subs = new Set<() => void>()
const set = (s: Partial<State>) => {
  state = { ...state, ...s }
  subs.forEach((f) => f())
}
export const useMe = () =>
  useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => subs.delete(f)
    },
    () => state,
  )

/** The signed-in wallet's state, when it is the connected wallet. */
export function useSession() {
  const s = useMe()
  const w = getWallet()
  const me = s.me?.address && s.me.address === w.address ? s.me : null
  const now = Date.now() / 1000
  return { me, loaded: s.loaded, signedIn: !!me, keyReady: !!me?.key && me.key.registeredUntil - now > 3600 }
}

export async function refresh() {
  try {
    const r = await fetch('/api/me', { credentials: 'same-origin' })
    if (r.ok) set({ me: await r.json(), loaded: true })
  } catch {
    /* keep the last */
  }
}

let poll = 0
export function startPolling() {
  if (poll) return
  refresh()
  poll = window.setInterval(refresh, 2000)
}

/** A call to the signed-in API. The X-PF header is what the server requires on every change. */
export async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-PF': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.code ? refusal(j, r.status) : (j.error ?? `http ${r.status}`))
  refresh()
  return j as T
}

export async function signIn() {
  const address = getWallet().address
  const { message } = await call<{ message: string }>('POST', '/api/auth/challenge', { address })
  const signature = await signMessage(message)
  await call('POST', '/api/auth/verify', { address, signature })
  await refresh()
}

export async function signOut() {
  await call('POST', '/api/auth/logout')
  set({ me: null })
}

/** Sets up (or renews) the trading key: the server makes it, the wallet signs its registration on Papertrade. */
export async function setUpKey(onStep: (s: string) => void) {
  const user = getWallet().address
  const k = await call<{ key: string; expiry: number; feeAddress: string }>('POST', '/api/me/key')
  onStep('Sign the trading key in your wallet')
  const { signed } = await signIntent(walletSigner(), 'exchange', 'RegisterSessionKey', user, {
    key: k.key,
    expiry: k.expiry,
    feeAddress: k.feeAddress,
    deadline: Math.floor(Date.now() / 1000) + 600,
  })
  await call('POST', '/api/me/key/register', { signed })
  onStep('Papertrade is registering the key')
  const until = Date.now() + 11 * 60_000
  while (Date.now() < until) {
    const exp = stream.state.account?.sessions[k.key.toLowerCase()] ?? 0
    if (exp * 1000 - Date.now() > 3600_000) {
      await refresh()
      return
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('Papertrade did not register the trading key in time')
}

/** Everything a farm needs: signed in, and a registered trading key. Asks the wallet only for what is missing. */
export async function ready(onStep: (s: string) => void) {
  if (!state.me?.address || state.me.address !== getWallet().address) {
    onStep('Sign in with your wallet')
    await signIn()
  }
  const me = state.me
  if (!me?.key || me.key.registeredUntil * 1000 - Date.now() < 3600_000) await setUpKey(onStep)
}

// ---- actions ----

export type Spec = { coin: CoinName; notional: number; lev: number; tp: number }

export const startFarm = (s: Spec & { slots: number }) => call<Farm>('POST', '/api/me/farms', s)
export const patchFarm = (id: string, p: { running?: boolean; tp?: number; slots?: number }) =>
  call<Farm>('PATCH', `/api/me/farms/${id}`, p)
export const stopFarm = (id: string) => call<{ closing: number }>('POST', `/api/me/farms/${id}/stop`)
export const deleteFarm = (id: string) => call('DELETE', `/api/me/farms/${id}`)
export const openPair = (s: Spec & { auto: boolean }) => call<PairRec>('POST', '/api/me/pairs', s)
export const patchPair = (id: string, p: { tp?: number; auto?: boolean; archived?: boolean }) =>
  call<PairRec>('PATCH', `/api/me/pairs/${id}`, p)
export const saveBoard = (b: unknown) => call('PUT', '/api/me/board', b)
export const closePair = (id: string) => call('POST', `/api/me/pairs/${id}/close`)
export const hedgePair = (id: string) => call<{ opening: string }>('POST', `/api/me/pairs/${id}/hedge`)
export const closePositions = (ids: string[]) => call('POST', '/api/me/positions/close', { ids })
export const hedgePosition = (id: string) => call<PairRec>('POST', '/api/me/positions/hedge', { id })
export const trackPositions = (long: string, short: string) =>
  call<PairRec>('POST', '/api/me/positions/track', { long, short })
export const cancelIntent = (id: string) => call('POST', `/api/me/intents/${id}/cancel`)

/** Slider edits arrive many times a second; send only the last one. */
const timers: Record<string, number> = {}
export function debounced(key: string, f: () => Promise<unknown>, ms = 400) {
  clearTimeout(timers[key])
  timers[key] = window.setTimeout(() => {
    f().catch(() => {})
  }, ms)
}
