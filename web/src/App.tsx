import { useEffect, useState } from 'react'
import { useStream } from './lib/account.ts'
import { useMarket } from './lib/api.ts'
import { signOut, startPolling, useSession } from './lib/me.ts'
import { connect, disconnect, useWallet } from './lib/wallet.ts'
import { Account } from './pages/Account.tsx'
import { Farm } from './pages/Farm.tsx'
import { Faq } from './pages/Faq.tsx'
import { Landing } from './pages/Landing.tsx'
import { Stats } from './pages/Stats.tsx'
import { External } from './components/icons.tsx'
import { ThemeToggle } from './components/ThemeToggle.tsx'
import { Toasts } from './components/Toasts.tsx'
import { short } from './lib/format.ts'

const PAGES = { farm: 'Farm', stats: 'Stats', account: 'Account', faq: 'FAQ' } as const
type Page = keyof typeof PAGES | 'home'

function useHash(): Page {
  const read = () => (location.hash.replace(/^#\/?/, '') || 'home') as Page
  const [p, setP] = useState(read)
  useEffect(() => {
    const f = () => setP(read())
    window.addEventListener('hashchange', f)
    return () => window.removeEventListener('hashchange', f)
  }, [])
  return p in PAGES ? p : 'home'
}

const LeaveIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path
      d="M8 4H5.5A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8M12 6.5 15.5 10 12 13.5M15.5 10H8"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

export function App() {
  const page = useHash()
  const w = useWallet()
  const s = useStream()
  const { signedIn } = useSession()
  const market = useMarket()
  useEffect(() => {
    startPolling()
  }, [])
  useEffect(() => {
    document.title = page === 'home' ? 'paperfarm — delta-neutral PAPER farming' : `${PAGES[page]} · paperfarm`
  }, [page])
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [page])
  const paused = market.data && (market.data.tradingPaused || market.data.paused.length > 0)

  return (
    <>
      <header className="top">
        {page !== 'home' && (
          <a className="wordmark" href="#/" aria-label="paperfarm, home">
            paperfarm<i>_</i>
          </a>
        )}
        {page === 'home' ? (
          <div className="end">
            <a href="#/faq">FAQ</a>
            <ThemeToggle />
            <a className="btn" href="#/farm">
              Open app
            </a>
          </div>
        ) : (
          <>
            <nav className="nav" aria-label="Pages">
              {(Object.keys(PAGES) as (keyof typeof PAGES)[]).map((p) => (
                <a
                  key={p}
                  href={`#/${p}`}
                  className={p === page ? 'on' : ''}
                  aria-current={p === page ? 'page' : undefined}
                >
                  {PAGES[p]}
                </a>
              ))}
            </nav>
            <div className="end">
              {w.address && (
                <a className="fund" href="https://exchange.papertrade.xyz" target="_blank" rel="noreferrer">
                  Funds on Papertrade <External />
                </a>
              )}
              <ThemeToggle />
              {w.address ? (
                <span className="wallet" title={w.address}>
                  <span
                    className={`dot ${s.status === 'live' ? 'on' : s.status === 'off' ? '' : 'wait'}`}
                    aria-label={s.status === 'live' ? 'Account live' : 'Account reconnecting'}
                  />
                  <span className="addr">{short(w.address)}</span>
                  <button
                    className="iconbtn"
                    onClick={() => {
                      if (signedIn) signOut().catch(() => {})
                      disconnect()
                    }}
                    aria-label="Sign out and disconnect"
                    title="Sign out"
                  >
                    <LeaveIcon />
                  </button>
                </span>
              ) : (
                <button className="btn" onClick={connect} disabled={w.connecting}>
                  {w.connecting ? 'Connecting…' : 'Connect wallet'}
                </button>
              )}
            </div>
          </>
        )}
      </header>
      {paused && (
        <div className="banner">
          Papertrade has paused {market.data!.tradingPaused ? 'all opens' : market.data!.paused.join(' and ')}. Farms
          wait until it resumes.
        </div>
      )}
      {w.error && <div className="banner">{w.error}</div>}
      {market.error && !market.data && (
        <div className="banner">Papertrade data is unavailable right now: {market.error}</div>
      )}
      <main>
        {page === 'home' && <Landing market={market.data} />}
        {page === 'farm' && <Farm market={market.data} />}
        {page === 'stats' && <Stats market={market.data} />}
        {page === 'account' && <Account market={market.data} />}
        {page === 'faq' && <Faq />}
      </main>
      <footer className="disclaim">
        paperfarm is independent and not affiliated with Papertrade. It trades with a key that can open and close
        positions and can never withdraw; your funds stay in your Papertrade account. Not financial advice: a leg that
        reaches its bust price loses its whole margin.
      </footer>
      <Toasts />
    </>
  )
}
