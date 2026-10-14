import { useEffect, useRef } from 'react'

/** The background: a slow field of tiny glyphs, dithered from drifting noise. It draws on the first frame. */
const RAMP = ' .·:-=+*'
const CW = 6,
  CH = 9
const hash = (x: number, y: number) => {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}
const vnoise = (x: number, y: number) => {
  const xi = Math.floor(x),
    yi = Math.floor(y),
    xf = x - xi,
    yf = y - yi
  const u = xf * xf * (3 - 2 * xf),
    v = yf * yf * (3 - 2 * yf)
  const a = hash(xi, yi),
    b = hash(xi + 1, yi),
    c = hash(xi, yi + 1),
    d = hash(xi + 1, yi + 1)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}
// domain-warped noise: soft shapes that drift and fold slowly
const field = (x: number, y: number, t: number) => {
  const wx = vnoise(x * 0.6 + t * 0.11, y * 0.6),
    wy = vnoise(x * 0.6 + 7.3, y * 0.6 - t * 0.09)
  const n = vnoise(x + wx * 2.2 + t * 0.05, y + wy * 2.2) * 0.7 + vnoise(x * 2.3 - t * 0.07, y * 2.3 + 3.1) * 0.3
  return Math.min(1, Math.max(0, (n - 0.3) / 0.6))
}

export function GlyphField() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current!,
      g = cv.getContext('2d')!
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let atlas: HTMLCanvasElement | null = null,
      ink = '',
      dpr = 1,
      raf = 0,
      last = -1e9,
      visible = true
    const build = () => {
      atlas = document.createElement('canvas')
      atlas.width = RAMP.length * CW * dpr
      atlas.height = CH * dpr
      const a = atlas.getContext('2d')!
      a.scale(dpr, dpr)
      a.font = '500 7.5px "Inter Variable", Inter, system-ui, sans-serif'
      a.fillStyle = ink
      a.globalAlpha = 0.42
      a.textAlign = 'center'
      a.textBaseline = 'middle'
      for (let i = 1; i < RAMP.length; i++) a.fillText(RAMP[i], i * CW + CW / 2, CH / 2)
    }
    const frame = (t: number) => {
      raf = still ? 0 : requestAnimationFrame(frame)
      if (!visible || t - last < 70) return // about 14 frames a second is plenty for a drift
      last = t
      const W = cv.clientWidth,
        H = cv.clientHeight
      if (!W || !H) return
      const d = window.devicePixelRatio || 1,
        c = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim()
      if (d !== dpr || c !== ink || !atlas) {
        dpr = d
        ink = c
        build()
      }
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
        cv.width = Math.round(W * dpr)
        cv.height = Math.round(H * dpr)
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, W, H)
      const cols = Math.ceil(W / CW),
        rows = Math.ceil(H / CH),
        T = t / 1000,
        n = RAMP.length
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const k = Math.floor(field(i * 0.045, j * 0.068, T) * n)
          if (k > 0) g.drawImage(atlas!, Math.min(n - 1, k) * CW * dpr, 0, CW * dpr, CH * dpr, i * CW, j * CH, CW, CH)
        }
      }
    }
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting
      if (still && visible) requestAnimationFrame(frame)
    })
    io.observe(cv)
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      io.disconnect()
    }
  }, [])
  return <canvas ref={ref} className="pricefield" aria-hidden="true" />
}
