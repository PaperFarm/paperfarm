import { useState } from 'react'
import { useStream } from '../lib/account.ts'
import { usePoll, type Market } from '../lib/api.ts'
import { errText, useWallet, withWallet } from '../lib/wallet.ts'
import { External } from '../components/icons.tsx'
import { toast } from '../components/Toasts.tsx'
import { compact, usd, when } from '../lib/format.ts'
import { Cell, NeedWallet, pendingYield } from './Stats.tsx'

export function Account({ market }: { market: Market | null }) {
  const w = useWallet()
  const { account: a } = useStream()
  const tr = usePoll<{ accRewardPerShareRaw: string }>('/paper/state/trading', 30_000).data
  const flows = usePoll<{
    items: {
      timestampMs: number
      amountRaw: string
      kind: string
      route: string
      withdrawalStatus: string | null
      txHash: string
    }[]
  }>(w.address ? `/paper/query/accounts/${w.address}/cashflows?limit=75` : null, 20_000).data
  const [stakeAmt, setStakeAmt] = useState('')
  const [busy, setBusy] = useState('')

  if (!w.address) return <NeedWallet what="your balance and staking" />
  if (!a)
    return (
      <div className="page">
        <div className="empty boxed">Connecting to your Papertrade account…</div>
      </div>
    )

  async function run(label: string, f: () => Promise<unknown>, ok: string) {
    setBusy(label)
    try {
      await f()
      toast(ok)
    } catch (e) {
      toast(errText(e), true)
    } finally {
      setBusy('')
    }
  }

  const yieldNow = pendingYield(a, tr?.accRewardPerShareRaw)
  const minStake = market?.minStake ?? 1000
  const stN = Number(stakeAmt) || 0

  return (
    <div className="page">
      <div className="pagehead">
        <h1 className="grow">Account</h1>
      </div>
      <div className="summary c3">
        <Cell k="Available" v={usd(a.avail)} s="Free to trade or withdraw" />
        <Cell k="Margin in use" v={usd(a.locked)} s={`${Object.keys(a.positions).length} open positions`} />
        <Cell
          k="Queue balance"
          v={usd(a.queued)}
          s={a.queued ? `${usd(a.availQueued)} usable as margin` : 'No queued payouts'}
        />
        <Cell k="PAPER" v={compact(a.paper.balance)} s={`${compact(a.paper.staked)} staked`} />
        <Cell k="Yield to claim" v={usd(yieldNow)} cls="pos" s={`${usd(a.lifetime.claimed)} claimed so far`} />
        <Cell k="Deposited" v={usd(a.lifetime.deposited)} s={`${usd(a.lifetime.withdrawn)} withdrawn`} />
      </div>
      <div className="section grid2">
        <section className="card panelbox" aria-labelledby="fund-h">
          <h2 id="fund-h">Funds</h2>
          <p>
            paperfarm trades with the balance already in your Papertrade account. It never moves your money in or out:
            deposits and withdrawals happen on Papertrade itself, with your wallet.
          </p>
          <a className="cta ghost" href="https://exchange.papertrade.xyz" target="_blank" rel="noreferrer">
            Deposit or withdraw on Papertrade <External />
          </a>
        </section>

        <section className="card panelbox" aria-labelledby="st-h">
          <h2 id="st-h">Stake PAPER</h2>
          <p>
            Staked PAPER earns half of every trading fee and the LP above $5M, paid in USDC. No lockup. At least{' '}
            {compact(minStake)} PAPER.
          </p>
          <div>
            <div className="labelrow">
              <span className="small ink2">
                {compact(a.paper.balance)} unstaked · {compact(a.paper.staked)} staked
              </span>
              <label className="lbl" htmlFor="st">
                Amount (PAPER)
              </label>
            </div>
            <div className="inputrow">
              <span className="chips">
                <button
                  className="chip"
                  onClick={() => setStakeAmt(String(Math.floor(a.paper.balance)))}
                  title="All unstaked PAPER"
                >
                  ALL
                </button>
                <button
                  className="chip"
                  onClick={() => setStakeAmt(String(Math.floor(a.paper.staked)))}
                  title="All staked PAPER"
                >
                  STAKED
                </button>
              </span>
              <span className="field">
                <input
                  id="st"
                  inputMode="decimal"
                  value={stakeAmt}
                  onChange={(e) => setStakeAmt(e.target.value.replace(/[^0-9.]/g, ''))}
                />
              </span>
            </div>
          </div>
          <div className="seg" role="group" aria-label="Staking actions">
            <button
              disabled={!!busy || stN < minStake || stN > a.paper.balance + 1e-9}
              onClick={() =>
                run(
                  'stake',
                  () =>
                    withWallet('staking', 'Stake', 'paperStake', {
                      amount: rawPaper(stN, a.paper.balance, a.paper.balanceRaw),
                    }),
                  'Stake sent',
                )
              }
            >
              {busy === 'stake' ? 'Sign…' : 'Stake'}
            </button>
            <button
              disabled={!!busy || stN <= 0 || stN > a.paper.staked + 1e-9}
              onClick={() =>
                run(
                  'unstake',
                  () =>
                    withWallet('staking', 'Unstake', 'paperUnstake', {
                      amount: rawPaper(stN, a.paper.staked, a.paper.stakedRaw),
                    }),
                  'Unstake sent',
                )
              }
            >
              {busy === 'unstake' ? 'Sign…' : 'Unstake'}
            </button>
          </div>
          <button
            className="cta"
            disabled={!!busy || yieldNow <= 0}
            onClick={() => run('claim', () => withWallet('staking', 'Claim', 'paperClaim', {}), 'Claim sent')}
          >
            {busy === 'claim' ? 'Sign in your wallet…' : `Claim ${usd(yieldNow)} yield`}
          </button>
        </section>
      </div>

      <div className="section">
        <h2>
          Deposits and withdrawals <span className="muted">on Papertrade</span>
        </h2>
        <div className="ttable scroll-x">
          <table className="t">
            <thead>
              <tr>
                <th>When</th>
                <th className="r">Amount</th>
                <th>Kind</th>
                <th>Route</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {(flows?.items ?? []).slice(0, 25).map((f) => (
                <tr key={f.txHash + f.kind}>
                  <td className="muted">{when(f.timestampMs)}</td>
                  <td className="r strong">{usd(Number(f.amountRaw) / 1e18)}</td>
                  <td>
                    <span className={`sidetag ${f.kind === 'Deposit' ? '' : 'short'}`}>{f.kind}</span>
                  </td>
                  <td className="ink2">{f.route}</td>
                  <td className="ink2">{f.withdrawalStatus ?? 'credited'}</td>
                </tr>
              ))}
              {!flows?.items?.length && (
                <tr>
                  <td colSpan={5} className="muted">
                    None yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

/** PAPER as an 18-decimal integer; asking for the whole (floored) balance sends the exact balance so no dust is left. */
function rawPaper(v: number, all: number, allRaw: bigint): string {
  return v >= Math.floor(all) ? allRaw.toString() : (BigInt(Math.floor(v * 1e6)) * 10n ** 12n).toString()
}
