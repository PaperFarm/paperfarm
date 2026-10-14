import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import GridLayout, { WidthProvider } from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import { Icon } from '../../components/icons.tsx'
import { BoardWin } from './BoardWindow.tsx'
import { Ticket } from './Ticket.tsx'
import { Win } from './Window.tsx'
import { BOARD_KEY, type BoardState, DEFAULT_BOARD, type Item, readBoard, validBoard, win } from './board.ts'
import { type Ctx } from './types.ts'
import { keep } from '../../lib/storage.ts'
import * as api from '../../lib/me.ts'

const Grid = WidthProvider(GridLayout)
const wideQuery = typeof window !== 'undefined' ? window.matchMedia('(min-width: 900px)') : null
const useWide = () =>
  useSyncExternalStore(
    (f) => {
      wideQuery?.addEventListener('change', f)
      return () => wideQuery?.removeEventListener('change', f)
    },
    () => wideQuery?.matches ?? true,
  )

export function Board({ ctx }: { ctx: Ctx }) {
  const wide = useWide()
  const { me, signedIn } = api.useSession()
  const [b, setB] = useState(readBoard)
  // The layout lives in this browser and, once signed in, with the wallet on the server, so it follows the wallet anywhere.
  const synced = useRef('')
  useEffect(() => {
    if (!me?.address || synced.current === me.address) return
    synced.current = me.address
    if (validBoard(me.board)) {
      setB(me.board)
      keep(BOARD_KEY, JSON.stringify(me.board))
    } else api.saveBoard(b).catch(() => {}) // first time on the server: keep what this browser has
  }, [me?.address]) // eslint-disable-line react-hooks/exhaustive-deps
  const save = (n: BoardState) => {
    if (JSON.stringify(n) === JSON.stringify(b)) return
    setB(n)
    keep(BOARD_KEY, JSON.stringify(n))
    if (signedIn) api.debounced('board', () => api.saveBoard(n), 800)
  }
  const add = () => {
    const i = `w${Date.now().toString(36)}`,
      bottom = b.layout.reduce((m, l) => Math.max(m, l.y + l.h), 0)
    save({
      items: [...b.items, { ...win(i, []), coin: ctx.coin }],
      layout: [...b.layout, { i, x: 0, y: bottom, w: 6, h: 10, minW: 3, minH: 3 }],
    })
  }
  const remove = (i: string) =>
    save({ items: b.items.filter((x) => x.i !== i), layout: b.layout.filter((l) => l.i !== i) })
  const set = (i: string, p: Partial<Item>) =>
    save({ ...b, items: b.items.map((x) => (x.i === i ? { ...x, ...p } : x)) })
  const render = (it: Item) =>
    it.i === 'new' ? (
      <Win title={<span className="win-title">New farm</span>}>
        <Ticket
          market={ctx.market}
          a={ctx.a}
          user={ctx.user}
          coin={ctx.coin}
          setCoin={ctx.setCoin}
          connecting={ctx.connecting}
        />
      </Win>
    ) : (
      <BoardWin it={it} ctx={ctx} set={(p) => set(it.i, p)} remove={() => remove(it.i)} />
    )
  const order = [...b.items].sort((x, y) => {
    const lx = b.layout.find((l) => l.i === x.i),
      ly = b.layout.find((l) => l.i === y.i)
    return (lx?.y ?? 0) - (ly?.y ?? 0) || (lx?.x ?? 0) - (ly?.x ?? 0)
  })
  return (
    <>
      <div className="boardbar">
        <button className="btn sm" onClick={add}>
          {Icon.plus}Add window
        </button>
        <span className="grow" />
        <button className="linkbtn" onClick={() => save(DEFAULT_BOARD)}>
          Reset layout
        </button>
      </div>
      {wide ? (
        <Grid
          className="board"
          layout={b.layout}
          cols={12}
          rowHeight={28}
          margin={[12, 12]}
          containerPadding={[0, 0]}
          draggableHandle=".win-drag"
          resizeHandles={['se', 'e', 's']}
          onLayoutChange={(l) => save({ ...b, layout: l })}
        >
          {b.items.map((it) => (
            <div key={it.i}>{render(it)}</div>
          ))}
        </Grid>
      ) : (
        <div className="stack">
          {order.map((it) => (
            <div key={it.i} className={it.blocks.includes('chart') ? 'has-chart' : ''}>
              {render(it)}
            </div>
          ))}
        </div>
      )}
    </>
  )
}
