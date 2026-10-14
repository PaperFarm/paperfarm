import { useState } from 'react'
import { Help } from '../../components/Help.tsx'
import { toast } from '../../components/Toasts.tsx'
import { openPnl } from './actions.ts'
import { type Account } from '../../lib/account.ts'
import { dur, signed, tone, usd } from '../../lib/format.ts'
import { priceOf, usePrices } from '../../lib/prices.ts'
import { errText } from '../../lib/wallet.ts'
import * as api from '../../lib/me.ts'

/** The account in one line, and the trading key the server farms with. */
export function AcctStrip({ a }: { a: Account }) {
  const { mids } = usePrices()
  const { me, signedIn, keyReady } = api.useSession()
  const [busy, setBusy] = useState('')
  const upnl = Object.values(a.positions).reduce((x, p) => x + openPnl(p, priceOf(mids, p.coin)), 0)
  const left = me?.key ? me.key.registeredUntil * 1000 - Date.now() : 0
  async function renew() {
    setBusy('Check your wallet…')
    try {
      if (!signedIn) await api.signIn()
      await api.setUpKey(setBusy)
      toast('Trading key ready')
    } catch (e) {
      toast(errText(e), true)
    } finally {
      setBusy('')
    }
  }
  return (
    <div className="strip" aria-label="Account">
      <span>
        <Help label="Equity" tip="Cash, margin in positions, queued payouts and open PnL together." />
        <b>{usd(a.balance + a.locked + a.queued + upnl)}</b>
      </span>
      <span>
        <Help label="Available" tip="Cash you can farm with now." />
        <b>{usd(a.avail)}</b>
      </span>
      <span>
        <Help label="In pairs" tip="Margin locked in open positions, both legs of every pair." />
        <b>{usd(a.locked)}</b>
      </span>
      <span>
        <Help
          label="Open PnL"
          tip="What open positions are up or down at Hyperliquid's mid, before Papertrade's haircut on wins."
        />
        <b className={tone(upnl)}>{signed(upnl)}</b>
      </span>
      <span>
        <Help
          label="Payout queue"
          tip="Wins Papertrade's LP owes you but has not paid yet. Paid out as the LP refills."
        />
        <b>{usd(a.queued)}</b>
      </span>
      <span className="key">
        <span className={`dot ${keyReady ? 'on' : signedIn ? 'wait' : ''}`} />
        <span className="ink2">
          {keyReady ? `Trading key · ${dur(left)} left` : signedIn ? 'No trading key' : 'Not signed in'}
        </span>
        <button className="linkbtn" disabled={!!busy} onClick={renew}>
          {busy || (keyReady ? 'Renew' : signedIn ? 'Set up' : 'Sign in')}
        </button>
      </span>
    </div>
  )
}
