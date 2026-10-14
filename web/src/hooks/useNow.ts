import { useEffect, useState } from 'react'

/** Re-renders every `ms`; for clocks and ages. */
export function useNow(ms = 1000) {
  const [n, setN] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setN(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return n
}
