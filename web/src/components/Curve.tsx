import { useMemo } from 'react'
import { compact, usd, when } from '../lib/format.ts'

// ---- the stats curve: cumulative PAPER against cumulative cost ----

export function Curve({ pts }: { pts: { t: number; paper: number; cost: number }[] }) {
  const W = 1000,
    H = 240
  const d = useMemo(() => {
    if (pts.length < 2) return null
    const t0 = pts[0].t,
      t1 = pts[pts.length - 1].t || t0 + 1
    const pMax = Math.max(...pts.map((p) => p.paper), 1)
    const cMin = Math.min(0, ...pts.map((p) => p.cost)),
      cMax = Math.max(1, ...pts.map((p) => p.cost))
    const X = (t: number) => ((t - t0) / (t1 - t0 || 1)) * W
    const yp = (v: number) => H - 4 - (v / pMax) * (H - 24)
    const yc = (v: number) => H - 4 - ((v - cMin) / (cMax - cMin)) * (H - 24)
    const path = (f: (p: (typeof pts)[0]) => number) =>
      pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${f(p).toFixed(1)}`).join('')
    const end = pts[pts.length - 1] // the labels say the totals; the max only sets the scale
    return {
      paper: path((p) => yp(p.paper)),
      area: path((p) => yp(p.paper)) + `L${W},${H}L0,${H}Z`,
      cost: path((p) => yc(p.cost)),
      paperTotal: end.paper,
      costTotal: end.cost,
      t0,
      t1,
    }
  }, [pts])
  if (!d) return <div className="empty">Nothing settled yet. The curve draws itself as pairs close.</div>
  return (
    <div className="curve">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Cumulative PAPER minted and cumulative cost over time"
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1="0"
            x2={W}
            y1={f * H}
            y2={f * H}
            style={{ stroke: 'var(--border)' }}
            strokeDasharray="3 5"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <path d={d.area} style={{ fill: 'rgb(var(--pos-rgb) / 0.08)' }} />
        <path
          d={d.paper}
          fill="none"
          style={{ stroke: 'var(--pos)' }}
          strokeWidth="2.2"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d={d.cost}
          fill="none"
          style={{ stroke: 'var(--neg)' }}
          strokeWidth="1.6"
          strokeDasharray="6 4"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span className="end">
        <b className="pos">{compact(d.paperTotal)} PAPER</b>
        <b className={d.costTotal > 0 ? 'neg' : 'pos'}>
          {usd(Math.abs(d.costTotal))} {d.costTotal > 0 ? 'cost' : 'gained'}
        </b>
      </span>
      <span className="axis">
        <span>{when(d.t0, false)}</span>
        <span>{when(d.t1, false)}</span>
      </span>
    </div>
  )
}
