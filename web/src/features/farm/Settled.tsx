import { type Stats, usePoll } from '../../lib/api.ts'
import { ago, compact, signed, tone, usdc } from '../../lib/format.ts'

/** The last positions Papertrade settled for this wallet. */
export function SettledBody({ user }: { user: string }) {
  const recent = usePoll<Stats>(`/api/stats/${user}`, 60_000).data?.recent.slice(0, 12) ?? []
  if (!recent.length) return <div className="empty">Nothing settled yet.</div>
  return (
    <ul className="settled">
      {recent.map((t) => (
        <li key={t.positionId}>
          <span className="ink2">{ago(t.closedAt)} ago</span>
          <span>
            {t.coin} {t.long ? 'long' : 'short'} {usdc(t.margin * t.leverage)}
          </span>
          <span className={`r ${tone(t.pnl)}`}>{signed(t.pnl)}</span>
          <span className="r">{t.paper > 0 ? `${compact(t.paper)} PAPER` : ''}</span>
        </li>
      ))}
    </ul>
  )
}
