import { useEffect, useState } from 'react'
import { PriceChart, TIMEFRAMES, type Timeframe } from '../../components/PriceChart.tsx'
import { Icon } from '../../components/icons.tsx'
import { Exposure, Farms } from './Farms.tsx'
import { MarketBody } from './MarketStats.tsx'
import { Positions } from './Positions.tsx'
import { SettledBody } from './Settled.tsx'
import { Welcome } from './Welcome.tsx'
import { WinPair } from './WinPair.tsx'
import { Win } from './Window.tsx'
import { BLOCKS, type Block, type Item, sourceOf, tfOf } from './board.ts'
import { chartMarks } from './chartMarks.ts'
import { COINS, type Ctx } from './types.ts'
import { pct, px, tone, usd } from '../../lib/format.ts'
import { priceOf, usePrices } from '../../lib/prices.ts'

/** A coin's live price and day change; its own component so a tick re-renders only this. */
function LivePrice({ coin }: { coin: string }) {
  const { mids, prevDay } = usePrices()
  const mid = priceOf(mids, coin),
    prev = prevDay[coin] ?? 0
  const ch = mid && prev ? mid / prev - 1 : null
  return (
    <span className="win-price">
      <b>{coin}</b>
      {px(mid)}
      {ch != null && (
        <span className={tone(ch)}>
          {ch > 0 ? '+' : ''}
          {pct(ch)}
        </span>
      )}
    </span>
  )
}

/** Whether the price feed is streaming. */
function LiveBadge() {
  const { live } = usePrices()
  return (
    <span
      className={`livebadge ${live ? '' : 'off'}`}
      title={live ? 'Streaming from Hyperliquid' : 'Reconnecting to Hyperliquid'}
    >
      {live ? 'Live' : 'Reconnecting'}
    </span>
  )
}

/** Toggles what a window holds. */
function Picker({ blocks, toggle }: { blocks: Block[]; toggle: (b: Block) => void }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.('.picker')) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  return (
    <span className="picker">
      <button
        className={`iconbtn sm ${open ? 'on' : ''}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label="Choose what this window shows"
        title="Choose what this window shows"
      >
        {Icon.plus}
      </button>
      {open && (
        <span className="menu" role="menu">
          {BLOCKS.map(([k, l]) => (
            <button
              key={k}
              role="menuitemcheckbox"
              aria-checked={blocks.includes(k)}
              className={blocks.includes(k) ? 'on' : ''}
              onClick={() => toggle(k)}
            >
              {Icon.check}
              {l}
            </button>
          ))}
        </span>
      )}
    </span>
  )
}

export function BoardWin({
  it,
  ctx,
  set,
  remove,
}: {
  it: Item
  ctx: Ctx
  set: (p: Partial<Item>) => void
  remove: () => void
}) {
  const has = (k: Block) => it.blocks.includes(k)
  const coinBound = has('chart') || has('pairs')
  const toggle = (k: Block) =>
    set({ blocks: has(k) ? it.blocks.filter((x) => x !== k) : BLOCKS.map(([x]) => x).filter((x) => x === k || has(x)) })
  // what this window can be narrowed to: farms (and pairs opened by hand), of its coin when it shows a chart or pairs
  const farmsHere = ctx.farms.filter((f) => !coinBound || f.coin === it.coin)
  const sources: { id: string; label: string }[] = [
    ...farmsHere.map((f) => ({
      id: f.id,
      label: `${coinBound ? '' : `${f.coin} `}Farm ${f.lev}× ${usd(f.notional, 0)}`,
    })),
    ...(coinBound
      ? ctx.active
          .filter((p) => p.rec.coin === it.coin && !p.rec.farm)
          .map((p) => ({ id: p.rec.id, label: `Pair ${p.rec.lev}× ${usd(p.rec.notional, 0)}` }))
      : []),
  ]
  const farmsShown = farmsHere.filter((f) => !it.sel || it.sel.includes(f.id))
  const shown = ctx.active.filter((p) => p.rec.coin === it.coin && (!it.sel || it.sel.includes(sourceOf(p))))
  const marks = chartMarks(shown)
  const pick = (id: string) => {
    const cur = it.sel ?? []
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
    set({ sel: next.length ? next : null })
  }
  const label = (k: Block) =>
    it.blocks.length > 1 && !(k === 'chart') ? (
      <div className="blk-head">{k === 'pairs' ? `${it.coin} pairs` : BLOCKS.find((x) => x[0] === k)![1]}</div>
    ) : null
  const body = (k: Block) => {
    switch (k) {
      case 'chart':
        return <PriceChart coin={it.coin} tf={tfOf(it)} lines={marks.lines} bands={marks.bands} />
      case 'pairs':
        return shown.length ? (
          shown.map((p, n) => <WinPair key={p.rec.id} v={p} n={n + 1} />)
        ) : (
          <div className="empty">
            No {it.coin} pairs open{it.sel ? ' for this selection' : ''}.
          </div>
        )
      case 'farms':
        return !ctx.a ? (
          <Welcome />
        ) : farmsShown.length ? (
          <>
            <Exposure a={ctx.a} />
            <Farms farms={farmsShown} views={ctx.active} market={ctx.market} />
          </>
        ) : (
          <div className="empty">
            {ctx.farms.length ? 'No farms in this selection.' : 'No farms yet. Start one in New farm.'}
          </div>
        )
      case 'positions':
        return ctx.a ? (
          <Positions ctx={ctx} a={ctx.a} />
        ) : (
          <div className="empty">Connect a wallet to see its positions.</div>
        )
      case 'market':
        return <MarketBody market={ctx.market} coin={it.coin} />
      case 'settled':
        return ctx.user ? (
          <SettledBody user={ctx.user} />
        ) : (
          <div className="empty">Connect a wallet to see its closes.</div>
        )
    }
  }
  return (
    <Win
      remove={remove}
      title={
        coinBound ? (
          <LivePrice coin={it.coin} />
        ) : (
          <span className="win-title">
            {it.blocks.length ? it.blocks.map((k) => BLOCKS.find((x) => x[0] === k)![1]).join(' · ') : 'New window'}
          </span>
        )
      }
      controls={
        <>
          {(coinBound || has('market')) && (
            <span className="seg sm" role="group" aria-label="Coin">
              {COINS.map((c) => (
                <button
                  key={c}
                  className={c === it.coin ? 'on' : ''}
                  aria-pressed={c === it.coin}
                  onClick={() => set({ coin: c, sel: null })}
                >
                  {c}
                </button>
              ))}
            </span>
          )}
          {has('chart') && (
            <span className="tfgroup">
              <select
                className="tfsel"
                value={tfOf(it)}
                onChange={(e) => set({ tf: e.target.value as Timeframe })}
                aria-label="Timeframe"
              >
                {TIMEFRAMES.map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
              <LiveBadge />
            </span>
          )}
          <Picker blocks={it.blocks} toggle={toggle} />
        </>
      }
      below={
        (coinBound || has('farms')) && sources.length > 0 ? (
          <div className="win-sel" role="group" aria-label="Farms and pairs in this window">
            <span className="lbl">Show</span>
            <button className={`chip sm ${!it.sel ? 'on' : ''}`} onClick={() => set({ sel: null })}>
              {coinBound ? `All ${it.coin}` : 'All farms'}
            </button>
            {sources.map((x) => (
              <button
                key={x.id}
                className={`chip sm ${it.sel?.includes(x.id) ? 'on' : ''}`}
                aria-pressed={!!it.sel?.includes(x.id)}
                onClick={() => pick(x.id)}
              >
                {x.label}
              </button>
            ))}
          </div>
        ) : null
      }
    >
      {it.blocks.length === 0 ? (
        <div className="blank">
          <p>Choose what this window shows.</p>
          <div className="row">
            {BLOCKS.map(([k, l]) => (
              <button key={k} className="chip sm" onClick={() => toggle(k)}>
                {Icon.plus}
                {l}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className={`blocks ${has('chart') ? 'with-chart' : ''}`}>
          {it.blocks.map((k) => (
            <div key={k} className={`blk blk-${k}`}>
              {label(k)}
              {body(k)}
            </div>
          ))}
        </div>
      )}
    </Win>
  )
}
