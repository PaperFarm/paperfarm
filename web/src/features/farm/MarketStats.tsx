import { Help } from '../../components/Help.tsx'
import { Kv } from '../../components/Kv.tsx'
import { type Market } from '../../lib/api.ts'
import { usd, usdc } from '../../lib/format.ts'
import { type CoinName } from '../../lib/paper.ts'

/** Papertrade's numbers that set the price of PAPER. */
export function MarketBody({ market, coin }: { market: Market | null; coin: CoinName }) {
  const lp = market?.mint.trackedLp ?? 0
  const row = market?.coins[coin]?.table.find((r) => r.tp === 0.005)
  return (
    <div className="mstats">
      <Kv
        k={<Help label="Mint rate" tip="PAPER minted per $1 of realised loss right now." />}
        v={market ? `${market.rate.toFixed(1)} / $` : '—'}
      />
      <Kv
        k={
          <Help
            label={`Cost per 1K, ${coin}`}
            tip={`Estimated cost per 1,000 PAPER for a ${coin} pair closed at a 0.5% move.`}
          />
        }
        v={row ? usd(row.costPer1k) : '—'}
      />
      <Kv
        k={<Help label="LP" tip="Tracked LP: PAPER mints flat below $2M; stakers get the LP above $5M." />}
        v={
          <span className="row">
            {market ? usdc(lp) : '—'}
            <span className="gauge" aria-hidden="true">
              <i style={{ width: `${Math.min(100, Math.max(0, (lp / 6e6) * 100))}%` }} />
              <u style={{ left: '33%' }} />
              <u style={{ left: '83%' }} />
            </span>
          </span>
        }
      />
      <Kv
        k={<Help label="Payouts owed" tip="Winning closes the LP owes but has not paid yet." />}
        v={market ? (market.queueCount ? usdc(market.queueTotal) : 'None') : '—'}
      />
    </div>
  )
}
