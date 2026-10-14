import { type ReactNode } from 'react'
import { Icon } from '../../components/icons.tsx'

/** The window frame: a bar to drag it by, its controls, and what it holds. */
export function Win({
  title,
  controls,
  below,
  remove,
  children,
}: {
  title: ReactNode
  controls?: ReactNode
  below?: ReactNode
  remove?: () => void
  children: ReactNode
}) {
  return (
    <section className="win board-win">
      <div className="win-bar">
        <span className="win-drag" title="Drag to move">
          {Icon.grip}
          {title}
        </span>
        {controls}
        {remove && (
          <button className="iconbtn sm" onClick={remove} aria-label="Close window" title="Close window">
            {Icon.close}
          </button>
        )}
      </div>
      {below}
      <div className="win-content">{children}</div>
    </section>
  )
}
