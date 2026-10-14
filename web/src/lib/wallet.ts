// The user's wallet (any EIP-1193 browser wallet). It signs three things only: the sign-in message, the
// registration of the trading key the server holds for it, and staking actions. It never trades.
import { useSyncExternalStore } from 'react'
import { createWalletClient, custom, toHex, type Hex } from 'viem'
import { stream } from './account.ts'
import { signIntent, type DomainName, type Signed, type Signer } from './paper.ts'

type Eth = {
  request: (a: { method: string; params?: unknown[] }) => Promise<any>
  on?: (e: string, f: (...a: any[]) => void) => void
}
declare global {
  interface Window {
    ethereum?: Eth
  }
}

type WalletState = { address: string; connecting: boolean; error: string }
let state: WalletState = { address: '', connecting: false, error: '' }
const subs = new Set<() => void>()
function set(s: Partial<WalletState>) {
  state = { ...state, ...s }
  subs.forEach((f) => f())
  stream.watch(state.address)
}
export const useWallet = () =>
  useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => subs.delete(f)
    },
    () => state,
  )
export const getWallet = () => state

const HYPEREVM = {
  chainId: '0x3e7',
  chainName: 'HyperEVM',
  nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
  rpcUrls: ['https://rpc.hyperliquid.xyz/evm'],
  blockExplorerUrls: ['https://hyperevmscan.io'],
}

export function initWallet() {
  const eth = window.ethereum
  if (!eth) return
  eth.on?.('accountsChanged', (a: string[]) => set({ address: (a[0] ?? '').toLowerCase() }))
  if (localStorage.getItem('pf:connected'))
    eth
      .request({ method: 'eth_accounts' })
      .then((a: string[]) => a[0] && set({ address: a[0].toLowerCase() }))
      .catch(() => {})
}

export async function connect() {
  const eth = window.ethereum
  if (!eth) {
    set({ error: 'No browser wallet found. Install Rabby or MetaMask.' })
    return
  }
  set({ connecting: true, error: '' })
  try {
    const a: string[] = await eth.request({ method: 'eth_requestAccounts' })
    localStorage.setItem('pf:connected', '1')
    set({ address: (a[0] ?? '').toLowerCase(), connecting: false })
  } catch (e) {
    set({ connecting: false, error: errText(e) })
  }
}

export function disconnect() {
  localStorage.removeItem('pf:connected')
  set({ address: '' })
}

/** Wallets refuse typed data for a chain other than the one they are on: Papertrade's domain is HyperEVM (999). */
async function onHyperEVM(eth: Eth) {
  const id = await eth.request({ method: 'eth_chainId' })
  if (parseInt(id, 16) === 999) return
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: HYPEREVM.chainId }] })
  } catch (e: any) {
    if (e?.code !== 4902 && e?.data?.originalError?.code !== 4902) throw e
    await eth.request({ method: 'wallet_addEthereumChain', params: [HYPEREVM] })
  }
}

export function walletSigner(): Signer {
  const eth = window.ethereum
  if (!eth || !state.address) throw new Error('Connect a wallet first')
  const client = createWalletClient({ transport: custom(eth) })
  return {
    address: state.address,
    signTypedData: async (td) => {
      await onHyperEVM(eth)
      return client.signTypedData({ account: state.address as Hex, ...td } as never)
    },
  }
}

/** personal_sign of a plain message (the sign-in). */
export async function signMessage(message: string): Promise<string> {
  const eth = window.ethereum
  if (!eth || !state.address) throw new Error('Connect a wallet first')
  return eth.request({ method: 'personal_sign', params: [toHex(message), state.address] })
}

// ---- wallet-signed intents (staking), sent through this site's Papertrade proxy ----

// Papertrade's own wording, as its exchange shows it: admission refusals by reason, other failures by code.
const REASONS: Record<string, string> = {
  tradingPaused: 'Trading is paused. Please try again once trading resumes.',
  marketPaused: 'This market is paused. Please try again once it reopens.',
  inactiveInstrument: 'This market is no longer available for trading.',
  belowMinimum: 'Your margin is below the minimum trade size. Increase it and try again.',
  belowMinimumNotional:
    'Position value (margin × leverage) is below the minimum. Increase your margin or leverage and try again.',
  leverageTooHigh: 'Leverage exceeds this market’s limit. Lower it and try again.',
  positionTooLarge: 'This position exceeds the market’s size limit. Reduce your margin or leverage.',
  openInterest: 'This market has reached its open interest limit. Reduce your position size or try again later.',
  funding: 'Your available collateral has changed. Review your balance and reduce the trade size.',
  noOpenPositions: 'These positions are already closed or have a close request pending.',
  paperBalance: 'You do not have enough available PAPER to stake this amount.',
  stakedBalance: 'You do not have enough staked PAPER to unstake this amount.',
  sessionKeyLimit:
    'This wallet has reached its trading session limit. Reuse an existing session or wait for one to expire.',
  noDeposit: 'Deposit funds to enable trading.',
  noRewards: 'You have no rewards to claim right now.',
}
const CODES: Record<string, string> = {
  invalid_intent: 'This request could not be validated. Review it and try again.',
  deadline_expired: 'This request expired before it was accepted. Review it and try again.',
  unauthorized_intent: 'Your trading authorization is no longer valid. Authenticate again to continue.',
  intent_not_found: 'This request could not be found. Check your activity for its latest status.',
  below_minimum_withdrawal: 'Withdraw at least 10 USDC to HyperCore.',
  rate_limited: 'Too many requests. Please try again shortly.',
}

/** Turns a Papertrade refusal ({code, reason, message}) into a sentence. */
export function refusal(
  j: { code?: string; error?: string; reason?: string; message?: string; payload?: { code?: string; reason?: string } },
  status: number,
): string {
  const code = j.code ?? j.payload?.code ?? j.error ?? (status === 429 ? 'rate_limited' : '')
  const reason = j.reason ?? j.payload?.reason ?? ''
  return (
    (code === 'admission_rejected' ? REASONS[reason] : undefined) ??
    CODES[code] ??
    `This request could not be accepted${reason || code ? ` (${reason || code})` : ''}. Review your account and try again.`
  )
}

async function submit(action: string, signed: Signed, id: string): Promise<void> {
  const res = await fetch('/paper/intents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, signed }),
  })
  const j = await res.json().catch(() => ({}))
  if (res.ok || j.code === 'intent_conflict') {
    if (res.ok && j.intentId && j.intentId.toLowerCase() !== id.toLowerCase())
      throw new Error(`Papertrade acknowledged ${j.intentId}, we signed ${id}`)
    return
  }
  throw new Error(refusal(j, res.status))
}

/** Stake, unstake and claim: signed by the wallet itself. */
export async function withWallet(dom: DomainName, primary: string, action: string, msg: Record<string, unknown>) {
  const { signed, id } = await signIntent(walletSigner(), dom, primary, state.address, {
    ...msg,
    deadline: Math.floor(Date.now() / 1000) + 600,
  })
  await submit(action, signed, id)
}

export function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  if (/user (rejected|denied)|rejected the request|denied transaction|user cancel/i.test(m))
    return 'Cancelled in the wallet'
  return m.split('\n')[0].slice(0, 240)
}
