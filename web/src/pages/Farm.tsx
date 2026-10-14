import { useState } from 'react'
import { AcctStrip } from '../features/farm/AccountStrip.tsx'
import { Board } from '../features/farm/Board.tsx'
import { useRankPoller } from '../features/farm/QueueTable.tsx'
import { type Ctx } from '../features/farm/types.ts'
import { useNow } from '../hooks/useNow.ts'
import { useStream } from '../lib/account.ts'
import { type Market } from '../lib/api.ts'
import { derive, findPairs } from '../lib/pairs.ts'
import { type CoinName } from '../lib/paper.ts'
import { keep, store } from '../lib/storage.ts'
import { useWallet } from '../lib/wallet.ts'
import * as api from '../lib/me.ts'

export function Farm({ market }: { market: Market | null }) {
  const w = useWallet()
  const { account: a, status } = useStream()
  const { me } = api.useSession()
  const recs = me?.pairs ?? []
  const now = useNow(1000)
  const [coin, setCoinState] = useState<CoinName>(() => store('pf:coin', 'BTC') as CoinName)
  const setCoin = (c: CoinName) => {
    setCoinState(c)
    keep('pf:coin', c)
  }
  useRankPoller(w.address, !!a && Object.keys(a.ops).length > 0)

  const views = a ? recs.filter((r) => !r.archived).map((r) => derive(r, a, now)) : []
  const active = views.filter((v) => v.state !== 'closed' && v.state !== 'failed')
  const done = views.filter((v) => v.state === 'closed' || v.state === 'failed').reverse()
  const owned = new Set<string>()
  for (const r of recs) for (const id of [r.legs.long, r.legs.short]) if (id) owned.add(id)
  for (const v of active) for (const l of [v.long, v.short]) if (l.pos) owned.add(l.pos.id)
  const found = findPairs(a ? Object.values(a.positions).filter((p) => !owned.has(p.id)) : [])
  const ctx: Ctx = {
    a,
    user: w.address,
    market,
    active,
    done,
    found,
    farms: me?.farms ?? [],
    coin,
    setCoin,
    connecting: !!w.address && status === 'connecting',
  }

  return (
    <div className="desk">
      {a && <AcctStrip a={a} />}
      <Board ctx={ctx} />
    </div>
  )
}
