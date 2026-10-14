import { useSyncExternalStore } from 'react'
import { Moon, Sun } from './icons.tsx'

// ---- theme: Papertrade's paper light and night, following the system unless chosen ----

type Theme = 'light' | 'dark'
const dark = matchMedia('(prefers-color-scheme: dark)')
const themeSubs = new Set<() => void>()
const readTheme = (): Theme => (document.documentElement.dataset.theme as Theme) || (dark.matches ? 'dark' : 'light')
try {
  const t = localStorage.getItem('pf:theme')
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t
} catch {
  /* private mode */
}
dark.addEventListener('change', () => themeSubs.forEach((f) => f()))
export const useTheme = () =>
  useSyncExternalStore((f) => {
    themeSubs.add(f)
    return () => themeSubs.delete(f)
  }, readTheme)

export function ThemeToggle() {
  const t = useTheme()
  const flip = () => {
    const next: Theme = t === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    try {
      localStorage.setItem('pf:theme', next)
    } catch {
      /* private mode */
    }
    themeSubs.forEach((f) => f())
  }
  return (
    <button
      className="iconbtn"
      onClick={flip}
      aria-label={t === 'dark' ? 'Switch to the light theme' : 'Switch to the night theme'}
      title={t === 'dark' ? 'Light theme' : 'Night theme'}
    >
      {t === 'dark' ? <Sun /> : <Moon />}
    </button>
  )
}
