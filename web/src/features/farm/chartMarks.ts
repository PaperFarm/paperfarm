import { type Band, type Line } from '../../components/PriceChart.tsx'
import { type PairView } from '../../lib/pairs.ts'

export function chartMarks(views: PairView[]): { lines: Line[]; bands: Band[] } {
  const lines: Line[] = [],
    bands: Band[] = []
  views.forEach((v, i) => {
    if (!v.entry) return
    const n = views.length > 1 ? ` ${i + 1}` : ''
    lines.push({ price: v.entry, tone: 'ink', label: `Pair${n} entry`, dash: true })
    bands.push({ lo: v.entry * (1 - v.rec.tp), hi: v.entry * (1 + v.rec.tp) })
    if (v.long.pos) lines.push({ price: v.long.pos.bust, tone: 'neg', label: `Long bust${n}` })
    if (v.short.pos) lines.push({ price: v.short.pos.bust, tone: 'neg', label: `Short bust${n}` })
  })
  return { lines, bands }
}
