import { GlyphField } from '../components/GlyphField.tsx'
import type { Market } from '../lib/api.ts'
import { cycle } from '../lib/paper.ts'
import { usePrices } from '../lib/prices.ts'
import { px, usd, usdc } from '../lib/format.ts'

const COINS = ['BTC', 'ETH']

const Yes = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M3.5 8.5 6.5 11.5 12.5 4.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)
const No = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
  </svg>
)

export function Landing({ market }: { market: Market | null }) {
  const btc = market?.coins.BTC
  const c = btc && market ? cycle(btc.impact, market.rate, 1000, 20, 0.005) : null
  return (
    <div className="landing">
      <section className="hero">
        <GlyphField />
        <Tape />
        <div className="hero-in">
          <h1 className="mark">
            paperfarm<i>_</i>
          </h1>
          <ul className="lines">
            <li>Delta-neutral PAPER farming on Papertrade</li>
          </ul>
          <div className="row actions">
            <a className="lbtn on" href="#/farm">
              Start farming
            </a>
            <a className="lbtn" href="#/faq">
              FAQ
            </a>
          </div>
        </div>
        <dl className="nowbox" aria-label="Papertrade now">
          <div>
            <dt>Cost per 1K PAPER</dt>
            <dd>{c ? usd(c.costPer1k) : '—'}</dd>
          </div>
          <div>
            <dt>Mint rate</dt>
            <dd>{market ? `${market.rate.toFixed(1)} / $` : '—'}</dd>
          </div>
          <div>
            <dt>LP</dt>
            <dd>{market ? usdc(market.mint.trackedLp) : '—'}</dd>
          </div>
        </dl>
      </section>

      <section className="keyinfo" aria-labelledby="key-h">
        <div>
          <h2 id="key-h">The trading key</h2>
          <p>
            paperfarm trades with a key your wallet approves on Papertrade. Papertrade limits it to opening and closing
            positions. It expires after 7 days, and you can revoke it from your wallet at any time.
          </p>
        </div>
        <ul aria-label="The key can">
          <li className="can">
            <Yes />
            Open positions
          </li>
          <li className="can">
            <Yes />
            Close positions
          </li>
        </ul>
        <ul aria-label="The key cannot">
          <li className="cannot">
            <No />
            Withdraw or transfer
          </li>
          <li className="cannot">
            <No />
            Stake or claim
          </li>
        </ul>
      </section>
    </div>
  )
}

/** Live prices along the top edge, like a tape. */
function Tape() {
  const { mids } = usePrices()
  const items = Array.from({ length: 12 }, (_, i) => COINS[i % 2])
  return (
    <div className="tape" aria-hidden="true">
      {items.map((c, i) => (
        <span key={i}>
          {c} {mids[c] ? px(mids[c]) : '—'}
        </span>
      ))}
    </div>
  )
}
