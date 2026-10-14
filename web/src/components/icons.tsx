export const Icon = {
  close: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  ),
  grip: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <g fill="currentColor">
        <circle cx="6" cy="4" r="1.1" />
        <circle cx="10" cy="4" r="1.1" />
        <circle cx="6" cy="8" r="1.1" />
        <circle cx="10" cy="8" r="1.1" />
        <circle cx="6" cy="12" r="1.1" />
        <circle cx="10" cy="12" r="1.1" />
      </g>
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3.5 8.5 6.5 11.5 12.5 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
}

// ---- icons, drawn once ----

/** Monochrome coin marks, as Papertrade sets its asset logos. */
export function CoinMark({ coin, className }: { coin: string; className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <circle cx="16" cy="16" r="16" fill="currentColor" />
      {coin === 'ETH' ? (
        <g fill="var(--page)">
          <path d="M16 5.5 23 16.6 16 20.6 9 16.6Z" />
          <path d="M16 22.1 23 18.1 16 27 9 18.1Z" />
        </g>
      ) : (
        <g fill="none" stroke="var(--page)" strokeWidth="2.1" strokeLinecap="round" transform="rotate(14 16 16)">
          <path d="M11.5 9.6h5.6a3.15 3.15 0 0 1 0 6.3h-5.6M11.5 15.9h6.3a3.3 3.3 0 0 1 0 6.6h-6.3M12.9 9.6v12.9M14 7v2.4M17 7v2.4M14 22.5V25M17 22.5V25" />
        </g>
      )}
    </svg>
  )
}

/** Opens on another site. */
export const External = () => (
  <svg className="ext" viewBox="0 0 16 16" aria-label="(opens Papertrade)">
    <path
      d="M6 3.5H3.5v9h9V10M9 3.5h3.5V7M12.5 3.5 7 9"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)
export const Chevron = () => (
  <svg className="chev" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M4 6l4 4 4-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)
export const Sun = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <circle cx="10" cy="10" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
    <path
      d="M10 1.8v2.1M10 16.1v2.1M1.8 10h2.1M16.1 10h2.1M4.2 4.2l1.5 1.5M14.3 14.3l1.5 1.5M4.2 15.8l1.5-1.5M14.3 5.7l1.5-1.5"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
  </svg>
)
export const Moon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path
      d="M16.5 12.4A7 7 0 0 1 7.6 3.5a7 7 0 1 0 8.9 8.9Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  </svg>
)
