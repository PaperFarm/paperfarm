import { useState } from 'react'
import { ClosedTable } from './ClosedTable.tsx'
import { Others } from './OthersTable.tsx'
import { PairsTable } from './PairsTable.tsx'
import { QueueTable } from './QueueTable.tsx'
import { act } from './actions.ts'
import { type Ctx } from './types.ts'
import { type Account } from '../../lib/account.ts'
import * as api from '../../lib/me.ts'

// ---- the table below ----

type Tab = 'pairs' | 'queue' | 'other' | 'closed'

export function Positions({ ctx, a }: { ctx: Ctx; a: Account }) {
  const [tab, setTab] = useState<Tab>('pairs')
  const [busy, setBusy] = useState(false)
  const { active, done, found, market } = ctx
  const ops = Object.values(a.ops).sort((x, y) => x.at - y.at)
  const others = found.pairs.length + found.single.length
  const open = active.filter((v) => v.long.pos || v.short.pos)
  const tabs: [Tab, string, number][] = [
    ['pairs', 'Pairs', active.length],
    ['queue', 'Queue', ops.length],
    ['other', 'Other positions', others],
    ['closed', 'Closed', done.length],
  ]
  async function closeAll() {
    setBusy(true)
    await act(
      async () => {
        for (const v of open) await api.closePair(v.rec.id)
      },
      `Close sent for ${open.length} pair${open.length > 1 ? 's' : ''}`,
    )
    setBusy(false)
  }
  return (
    <div className="work">
      <div className="tabs" role="tablist">
        {tabs.map(([t, l, n]) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? 'on' : ''}
            onClick={() => setTab(t)}
          >
            {l}
            {n > 0 && <span className="count">{n}</span>}
          </button>
        ))}
        {open.length > 0 && (
          <button className="btn sm close tabend" disabled={busy} onClick={closeAll}>
            Close all
          </button>
        )}
      </div>
      {tab === 'pairs' ? (
        <PairsTable views={active} market={market} />
      ) : tab === 'queue' ? (
        <QueueTable ops={ops} />
      ) : tab === 'other' ? (
        <Others found={found} market={market} />
      ) : (
        <ClosedTable views={done} />
      )}
    </div>
  )
}
