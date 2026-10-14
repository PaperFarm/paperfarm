import { useEffect, useRef, useState } from 'react'
import { useTheme } from './ThemeToggle.tsx'
import { px } from '../lib/format.ts'
import {
  INTERVAL_MS,
  type Interval,
  type Point,
  getCandles,
  getPoints,
  olderCandles,
  olderTicks,
  onTick,
  priceNow,
  watchCandles,
} from '../lib/prices.ts'

// ---- the candle chart: Hyperliquid 1m candles, Papertrade's monochrome style, pair levels on top ----

export type Line = { price: number; tone: 'ink' | 'pos' | 'neg'; label: string; dash?: boolean }
export type Band = { lo: number; hi: number }

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

const FONT = '"Inter Variable", Inter, system-ui, sans-serif'
export type Timeframe = 'tick' | Interval
export const TIMEFRAMES: [Timeframe, string][] = [
  ['tick', 'Tick'],
  ['1m', '1m'],
  ['5m', '5m'],
  ['15m', '15m'],
  ['1h', '1h'],
  ['4h', '4h'],
  ['1d', '1d'],
]
const DEFAULT_SPAN: Record<Timeframe, number> = {
  tick: 300,
  '1m': 90,
  '5m': 96,
  '15m': 96,
  '1h': 96,
  '4h': 90,
  '1d': 90,
} // seconds for tick, candles otherwise
const LABEL_STEPS = [
  10e3, 15e3, 30e3, 60e3, 120e3, 300e3, 600e3, 900e3, 1800e3, 3600e3, 7200e3, 10800e3, 14400e3, 21600e3, 43200e3,
  86400e3, 172800e3, 604800e3,
]

/** Papertrade-style price chart: a tick line of the live microprice, or candles. Scroll zooms, drag pans, hover reads, double-click returns to live. */
export function PriceChart({ coin, tf, lines, bands }: { coin: string; tf: Timeframe; lines: Line[]; bands: Band[] }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const theme = useTheme()
  const props = useRef({ lines, bands, tf })
  props.current = { lines, bands, tf }
  // span and back in units: seconds (tick) or candles; zoomed: the user set the span; y: a price range the user set, else automatic
  const view = useRef<{ span: number; back: number; zoomed: boolean; y: { mid: number; half: number } | null }>({
    span: DEFAULT_SPAN[tf],
    back: 0,
    zoomed: false,
    y: null,
  })
  const hover = useRef<{ x: number; y: number } | null>(null)
  const [moved, setMoved] = useState<'' | 'back' | 'scaled'>('')
  const redraw = useRef(() => {})
  const live = () => {
    view.current = { span: DEFAULT_SPAN[props.current.tf], back: 0, zoomed: false, y: null }
    setMoved('')
    redraw.current()
  }
  const autoscale = () => {
    view.current.y = null
    setMoved(view.current.back >= 0.5 ? 'back' : '')
    redraw.current()
  }
  useEffect(live, [tf, coin])
  useEffect(() => (tf === 'tick' ? undefined : watchCandles(coin, tf)), [coin, tf])
  const colors = useRef<Record<string, string> | null>(null) // read from the theme once, not every frame
  useEffect(() => {
    const cv = ref.current!
    const axisW = 66,
      axisH = 22,
      top = 12
    let raf = 0,
      shown = 0,
      dir = 0,
      visible = true // shown: the head eased toward each tick; dir: the last move's sign
    let auto = { lo: 0, hi: 0 } // the last automatic price range, where a manual scale starts from
    const unit = () => (props.current.tf === 'tick' ? 1000 : INTERVAL_MS[props.current.tf as Interval])
    const available = () =>
      props.current.tf === 'tick' ? 30 * 60 : getCandles(coin, props.current.tf as Interval).length // ticks: what the server keeps; candles: what is loaded (more load near the edge)
    const draw = () => {
      raf = 0
      const { lines, bands, tf } = props.current,
        tick = tf === 'tick',
        u = unit()
      if (tick && !view.current.zoomed) {
        // until zoomed, the tick view fits the ticks it has: 30 s to 5 min
        const first = getPoints(coin)[0]
        view.current.span = Math.round(
          Math.min(DEFAULT_SPAN.tick, Math.max(30, first ? ((Date.now() - first.t) / 1000) * 1.1 : 30)),
        )
      }
      const { span, back } = view.current
      const C = (colors.current ??= {
        page: css('--page'),
        future: css('--future'),
        ink: css('--ink'),
        ink2: css('--ink-2'),
        muted: css('--muted'),
        border: css('--border'),
        up: css('--candle-up'),
        pos: css('--pos'),
        neg: css('--neg'),
        onPos: css('--on-pos'),
      })
      const dpr = window.devicePixelRatio || 1,
        W = cv.clientWidth,
        H = cv.clientHeight
      if (!W || !H) return
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
        cv.width = Math.round(W * dpr)
        cv.height = Math.round(H * dpr)
      }
      const g = cv.getContext('2d')!
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, W, H)
      const plotW = W - axisW,
        plotH = H - axisH,
        isLive = back < 0.5
      const nowX = isLive ? plotW * 0.92 : plotW
      if (isLive) {
        g.fillStyle = C.future
        g.fillRect(nowX, 0, plotW - nowX, plotH)
      }
      g.strokeStyle = C.border
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(plotW + 0.5, 0)
      g.lineTo(plotW + 0.5, H)
      g.moveTo(0, plotH + 0.5)
      g.lineTo(plotW, plotH + 0.5)
      g.stroke()

      const now = Date.now()
      const t1 = (tick ? now : Math.floor(now / u) * u) - back * u,
        t0 = t1 - span * u
      if (tick) olderTicks(coin, t0)
      else if (back + span > getCandles(coin, tf as Interval).length - 40) olderCandles(coin, tf as Interval)
      const pts = tick ? visiblePoints(getPoints(coin), t0 - 2000, t1) : []
      const cs = tick ? [] : getCandles(coin, tf as Interval).filter((c) => c.t >= t0 - u && c.t <= t1 + u)
      g.font = `10px ${FONT}`
      g.textBaseline = 'middle'
      if (tick ? pts.length < 1 : cs.length < 2) {
        g.fillStyle = C.muted
        g.textAlign = 'left'
        g.fillText(tick ? 'Waiting for the first ticks…' : 'Loading Hyperliquid candles…', 12, top + 12)
        return
      }
      const price = priceNow(coin) || (tick ? pts[pts.length - 1].p : cs[cs.length - 1].c)
      if (shown && Math.abs(price - shown) > price * 1e-9) dir = Math.sign(price - shown)
      shown = shown && Math.abs(price - shown) < price * 0.01 ? shown + (price - shown) * 0.3 : price
      let lo = Infinity,
        hi = -Infinity
      for (const p of pts) {
        lo = Math.min(lo, p.p)
        hi = Math.max(hi, p.p)
      }
      for (const c of cs) {
        lo = Math.min(lo, c.l)
        hi = Math.max(hi, c.h)
      }
      if (isLive) {
        lo = Math.min(lo, shown)
        hi = Math.max(hi, shown)
        if (!tick)
          for (const b of bands) {
            lo = Math.min(lo, b.lo)
            hi = Math.max(hi, b.hi)
          }
      }
      const minRange = shown * (tick ? 0.0002 : 0.001)
      if (hi - lo < minRange) {
        const m = (hi + lo) / 2
        lo = m - minRange / 2
        hi = m + minRange / 2
      }
      const pad = (hi - lo) * 0.12
      lo -= pad
      hi += pad
      auto = { lo, hi }
      if (view.current.y) {
        lo = view.current.y.mid - view.current.y.half
        hi = view.current.y.mid + view.current.y.half
      }
      const y = (p: number) => top + (1 - (p - lo) / (hi - lo)) * (plotH - top - 8)
      const priceAt = (yy: number) => lo + (1 - (yy - top) / (plotH - top - 8)) * (hi - lo)
      const slot = nowX / span
      const x = (t: number) => nowX - ((t1 - t) / u + (tick ? 0 : 0.5)) * slot
      const timeAt = (xx: number) => t1 - ((nowX - xx) / slot - (tick ? 0 : 0.5)) * u
      g.save()
      g.beginPath()
      g.rect(0, 0, plotW, plotH)
      g.clip()
      const step = niceStep((hi - lo) / 5)
      g.setLineDash([3, 5])
      g.strokeStyle = C.border
      for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
        const yy = Math.round(y(p)) + 0.5
        g.beginPath()
        g.moveTo(0, yy)
        g.lineTo(plotW, yy)
        g.stroke()
      }
      g.setLineDash([])
      for (const b of bands) {
        if (b.hi < lo || b.lo > hi) continue
        g.fillStyle = withAlpha(C.pos, 0.08)
        g.fillRect(0, y(b.hi), plotW, y(b.lo) - y(b.hi))
      }
      if (tick) {
        // a step line: each price holds until the next tick, the last one runs to the live head
        g.beginPath()
        pts.forEach((p, i) => {
          const xx = x(p.t)
          if (i === 0) g.moveTo(xx, y(p.p))
          else {
            g.lineTo(xx, y(pts[i - 1].p))
            g.lineTo(xx, y(p.p))
          }
        })
        const hx = isLive ? nowX : x(pts[pts.length - 1].t)
        g.lineTo(hx, y(isLive ? shown : pts[pts.length - 1].p))
        g.lineJoin = 'round'
        g.lineWidth = 2.25
        g.strokeStyle = C.ink
        g.shadowColor = withAlpha(C.ink, 0.18)
        g.shadowBlur = 6
        g.stroke()
        g.shadowBlur = 0
      } else {
        const bw = Math.max(1, Math.min(9, slot * 0.62))
        for (const c of cs) {
          const cx = Math.round(x(c.t)) + 0.5
          if (cx < -10 || cx > plotW + 10) continue
          g.strokeStyle = C.ink
          g.lineWidth = 1
          g.beginPath()
          g.moveTo(cx, y(c.h))
          g.lineTo(cx, y(c.l))
          g.stroke()
          if (bw < 2) continue
          const yo = y(c.o),
            yc = y(c.c),
            bt = Math.min(yo, yc),
            bh = Math.max(1, Math.abs(yc - yo))
          g.fillStyle = c.c >= c.o ? C.up : C.ink
          g.fillRect(cx - bw / 2, bt, bw, bh)
          g.strokeRect(
            Math.round(cx - bw / 2) + 0.5,
            Math.round(bt) + 0.5,
            Math.max(0, Math.round(bw) - 1),
            Math.max(0, Math.round(bh) - 1),
          )
        }
      }
      // pair levels: drawn across when in range, else pinned to the edge they lie beyond
      let above = 0,
        below = 0
      for (const l of [...lines].sort((a, b) => b.price - a.price)) {
        const col = l.tone === 'pos' ? C.pos : l.tone === 'neg' ? C.neg : C.ink2,
          inside = l.price >= lo && l.price <= hi
        const yy = inside
          ? Math.round(y(l.price)) + 0.5
          : l.price > hi
            ? top + 2 + 18 * above++
            : plotH - 12 - 18 * below++
        if (inside) {
          g.strokeStyle = col
          g.lineWidth = 1
          g.setLineDash(l.dash ? [5, 4] : [])
          g.beginPath()
          g.moveTo(0, yy)
          g.lineTo(plotW, yy)
          g.stroke()
          g.setLineDash([])
        }
        const text = `${inside ? '' : l.price > hi ? '↑ ' : '↓ '}${l.label}  ${px(l.price)}`
        g.font = `600 9.5px ${FONT}`
        const tw = g.measureText(text).width + 10,
          lx = inside ? 6.5 : Math.round(plotW - tw - 8) + 0.5
        g.strokeStyle = col
        g.fillStyle = C.page
        roundRect(g, lx, yy - 8, tw, 16, 3)
        g.fill()
        g.stroke()
        g.fillStyle = col
        g.textAlign = 'left'
        g.fillText(text, lx + 5, yy)
      }
      const tagColor = dir < 0 ? C.neg : C.pos
      const ly = Math.round(y(isLive ? shown : tick ? pts[pts.length - 1].p : cs[cs.length - 1].c)) + 0.5
      if (isLive) {
        g.strokeStyle = tagColor
        g.lineWidth = 1
        g.setLineDash([2, 3])
        g.beginPath()
        g.moveTo(tick ? nowX : 0, ly)
        g.lineTo(plotW, ly)
        g.stroke()
        g.setLineDash([])
        if (tick) {
          g.fillStyle = withAlpha(C.ink, 0.14)
          g.beginPath()
          g.arc(nowX, ly, 9, 0, Math.PI * 2)
          g.fill()
          g.fillStyle = C.ink
          g.beginPath()
          g.arc(nowX, ly, 4, 0, Math.PI * 2)
          g.fill()
        }
      }
      const h = hover.current,
        inPlot = !!h && h.x < plotW && h.y < plotH
      if (h && inPlot) {
        g.strokeStyle = C.muted
        g.lineWidth = 1
        g.setLineDash([4, 4])
        g.beginPath()
        g.moveTo(Math.round(h.x) + 0.5, 0)
        g.lineTo(Math.round(h.x) + 0.5, plotH)
        g.moveTo(0, Math.round(h.y) + 0.5)
        g.lineTo(plotW, Math.round(h.y) + 0.5)
        g.stroke()
        g.setLineDash([])
      }
      g.restore()
      // axes and tags
      g.font = `10px ${FONT}`
      g.fillStyle = C.muted
      g.textAlign = 'left'
      for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
        const yy = y(p)
        if (yy > top - 6 && Math.abs(yy - ly) > 12) g.fillText(px(p), plotW + 7, yy)
      }
      const every = LABEL_STEPS.find((m) => (span * u) / m <= 6) ?? 604800e3
      const fmt = (t: number) =>
        every >= 86400e3
          ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          : every < 60e3
            ? new Date(t).toTimeString().slice(0, 8)
            : new Date(t).toTimeString().slice(0, 5)
      g.textAlign = 'center'
      for (let t = Math.ceil(t0 / every) * every; t <= t1; t += every) {
        const tx = x(t)
        if (tx > 24 && tx < nowX - 24) g.fillText(fmt(t), tx, plotH + axisH / 2)
      }
      g.fillStyle = tagColor
      roundRect(g, plotW + 3, ly - 8, axisW - 6, 16, 3)
      g.fill()
      g.fillStyle = C.onPos
      g.font = `600 10px ${FONT}`
      g.textAlign = 'left'
      g.fillText(px(isLive ? shown : tick ? pts[pts.length - 1].p : cs[cs.length - 1].c), plotW + 7, ly + 0.5)
      if (h && inPlot) {
        g.fillStyle = C.ink
        roundRect(g, plotW + 3, h.y - 8, axisW - 6, 16, 3)
        g.fill()
        g.fillStyle = C.page
        g.textAlign = 'left'
        g.fillText(px(priceAt(h.y)), plotW + 7, h.y + 0.5)
        const ht = timeAt(h.x)
        const label = tick ? new Date(ht).toTimeString().slice(0, 8) : fmt(Math.round(ht / u) * u)
        g.font = `600 10px ${FONT}`
        const lw = g.measureText(label).width + 12
        g.fillStyle = C.ink
        roundRect(g, h.x - lw / 2, plotH + 3, lw, 16, 3)
        g.fill()
        g.fillStyle = C.page
        g.textAlign = 'center'
        g.fillText(label, h.x, plotH + axisH / 2)
        const c = !tick && cs.find((k) => k.t === Math.round(ht / u) * u)
        if (c) {
          g.font = `500 10px ${FONT}`
          g.textAlign = 'left'
          g.fillStyle = C.ink2
          g.fillText(`O ${px(c.o)}   H ${px(c.h)}   L ${px(c.l)}   C ${px(c.c)}`, 8, 10)
        }
      }
      if (isLive && (tick || Math.abs(shown - price) > price * 1e-7)) kick() // the live tick view glides every frame; candles until the head settles
    }
    const kick = () => {
      if (!raf && visible && !document.hidden) raf = requestAnimationFrame(draw)
    }
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting
      kick()
    })
    io.observe(cv)
    const onVis = () => kick()
    document.addEventListener('visibilitychange', onVis)
    redraw.current = kick
    const clampBack = (b: number) => Math.min(Math.max(0, available() - view.current.span), Math.max(0, b))
    const sync = () => setMoved(view.current.back >= 0.5 ? 'back' : view.current.y ? 'scaled' : '')
    const area = (e: { clientX: number; clientY: number }) => {
      const r = cv.getBoundingClientRect(),
        xx = e.clientX - r.left,
        yy = e.clientY - r.top
      return xx > cv.clientWidth - axisW ? 'price' : yy > cv.clientHeight - axisH ? 'time' : 'plot'
    }
    const priceScale = () => view.current.y ?? { mid: (auto.lo + auto.hi) / 2, half: (auto.hi - auto.lo) / 2 }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const v = view.current,
        plotW = cv.clientWidth - axisW,
        tick = props.current.tf === 'tick'
      if (area(e) === 'price') {
        const s = priceScale()
        v.y = { mid: s.mid, half: Math.max(s.mid * 1e-6, s.half * Math.exp(e.deltaY * 0.0015)) }
        sync()
        kick()
        return
      }
      const span = Math.round(
        Math.min(Math.max(available(), tick ? 60 : 20), Math.max(tick ? 20 : 10, v.span * Math.exp(e.deltaY * 0.0015))),
      )
      const right = Math.max(0, Math.min(1, 1 - (e.clientX - cv.getBoundingClientRect().left) / plotW)) // keep the moment under the cursor in place
      v.back = clampBack(v.back + v.span * right - span * right)
      v.span = span
      v.zoomed = true
      sync()
      kick()
    }
    // drag the price axis to stretch prices, the time axis to stretch time, the chart itself to move both
    let drag: { what: string; x: number; y: number; back: number; span: number; mid: number; half: number } | null =
      null
    const onDown = (e: PointerEvent) => {
      const s = priceScale()
      drag = {
        what: area(e),
        x: e.clientX,
        y: e.clientY,
        back: view.current.back,
        span: view.current.span,
        mid: s.mid,
        half: s.half,
      }
      cv.setPointerCapture(e.pointerId)
      if (drag.what === 'plot') cv.style.cursor = 'grabbing'
    }
    const onMove = (e: PointerEvent) => {
      const r = cv.getBoundingClientRect(),
        v = view.current,
        plotW = cv.clientWidth - axisW,
        plotH = cv.clientHeight - axisH
      hover.current = e.pointerType === 'mouse' ? { x: e.clientX - r.left, y: e.clientY - r.top } : null
      if (!drag) {
        const a = area(e)
        cv.style.cursor = a === 'price' ? 'ns-resize' : a === 'time' ? 'ew-resize' : 'crosshair'
      } else if (drag.what === 'price') {
        v.y = { mid: drag.mid, half: Math.max(drag.mid * 1e-6, drag.half * Math.exp((e.clientY - drag.y) * 0.006)) } // down widens the range, up narrows it
        sync()
      } else if (drag.what === 'time') {
        const tick = props.current.tf === 'tick'
        v.span = Math.round(
          Math.min(
            Math.max(available(), tick ? 60 : 20),
            Math.max(tick ? 20 : 10, drag.span * Math.exp(-(e.clientX - drag.x) * 0.005)),
          ),
        ) // right zooms in, left out
        v.zoomed = true
        v.back = clampBack(v.back)
        sync()
      } else {
        v.back = clampBack(drag.back + ((e.clientX - drag.x) * v.span) / plotW)
        if (v.y) v.y = { mid: drag.mid + ((e.clientY - drag.y) * (2 * drag.half)) / (plotH - 20), half: drag.half } // a set price scale moves with the hand
        sync()
      }
      kick()
    }
    const onUp = () => {
      if (drag?.what === 'plot') cv.style.cursor = 'crosshair'
      drag = null
    }
    const onDbl = (e: MouseEvent) => (area(e) === 'price' ? autoscale() : live()) // the price axis resets just the price scale
    const onLeave = () => {
      hover.current = null
      kick()
    }
    cv.addEventListener('wheel', onWheel, { passive: false })
    cv.addEventListener('pointerdown', onDown)
    cv.addEventListener('pointermove', onMove)
    cv.addEventListener('pointerup', onUp)
    cv.addEventListener('pointerleave', onLeave)
    cv.addEventListener('dblclick', onDbl)
    const off = onTick(kick)
    const iv = setInterval(kick, 1000) // the tick line slides even between ticks
    const ro = new ResizeObserver(kick)
    ro.observe(cv)
    kick()
    return () => {
      off()
      clearInterval(iv)
      ro.disconnect()
      io.disconnect()
      document.removeEventListener('visibilitychange', onVis)
      cancelAnimationFrame(raf)
      cv.removeEventListener('wheel', onWheel)
      cv.removeEventListener('pointerdown', onDown)
      cv.removeEventListener('pointermove', onMove)
      cv.removeEventListener('pointerup', onUp)
      cv.removeEventListener('pointerleave', onLeave)
      cv.removeEventListener('dblclick', onDbl)
    }
  }, [coin]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    colors.current = null
    redraw.current()
  }, [theme])
  useEffect(() => redraw.current(), [lines, bands, tf])
  return (
    <div className="chart">
      <canvas
        ref={ref}
        role="img"
        aria-label={`${coin} price chart. Scroll or drag the time axis to zoom time, drag the price axis to scale prices, drag the chart to pan, double-click to reset.`}
      />
      {moved && (
        <button className="chip sm golive" onClick={moved === 'back' ? live : autoscale}>
          {moved === 'back' ? 'Back to live' : 'Auto scale'}
        </button>
      )}
    </div>
  )
}

/** The points from t0 to t1, found by binary search: the history holds thousands. */
function visiblePoints(all: Point[], t0: number, t1: number) {
  let lo = 0,
    hi = all.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (all[m].t < t0) lo = m + 1
    else hi = m
  }
  let end = lo
  while (end < all.length && all[end].t <= t1) end++
  return all.slice(lo, end)
}

function niceStep(raw: number) {
  const p = 10 ** Math.floor(Math.log10(raw)),
    n = raw / p
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p
}
function withAlpha(rgb: string, a: number) {
  return rgb.replace(/^rgb\(([^)]+)\)$/, (_, v) => `rgb(${v.split('/')[0].trim()} / ${a})`)
}
function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath()
  g.roundRect(x, y, w, h, r)
}
