// ---- numbers ----

export const usd = (v: number, d = 2) =>
  (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
export const signed = (v: number, d = 2) => (v > 0 ? '+' : '') + usd(v, d)
export const compact = (v: number) => {
  const a = Math.abs(v),
    s = v < 0 ? '-' : ''
  return a >= 1e12
    ? `${s}${(a / 1e12).toFixed(2)}T`
    : a >= 1e9
      ? `${s}${(a / 1e9).toFixed(2)}B`
      : a >= 1e6
        ? `${s}${(a / 1e6).toFixed(2)}M`
        : a >= 1e4
          ? `${s}${(a / 1e3).toFixed(1)}K`
          : `${s}${a.toLocaleString('en-US', { maximumFractionDigits: a < 10 ? 2 : 0 })}`
}
export const usdc = (v: number) => (v < 0 ? '-$' : '$') + compact(Math.abs(v))
export const pct = (v: number, d = 2) => `${(v * 100).toFixed(d)}%`
export const px = (v: number) =>
  v ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'
export const short = (a: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '')
export const dur = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60
    ? `${s}s`
    : s < 3600
      ? `${Math.floor(s / 60)}m`
      : s < 86400
        ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
        : `${Math.floor(s / 86400)}d`
}
export const ago = (ms: number) => dur(Date.now() - ms)
/** One date format everywhere: "Oct 14, 02:34", or "Oct 14" without the time. */
/** A UTC day bucket (its start, ms) as "Oct 14". */
export const day = (ms: number) =>
  new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
/** "Oct 14, 02:34" in UTC, to sit beside UTC day totals. */
export const whenUTC = (ms: number) =>
  new Date(ms).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  })
export const when = (ms: number, time = true) =>
  new Date(ms).toLocaleString(
    'en-US',
    time
      ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }
      : { month: 'short', day: 'numeric' },
  )
export const tone = (v: number) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '')
