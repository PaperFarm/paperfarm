export function Help({ label, tip }: { label: string; tip: string }) {
  return (
    <span className="help" tabIndex={0} data-tip={tip} aria-label={`${label}: ${tip}`}>
      {label}
      <span className="q" aria-hidden="true">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6.75" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <path
            d="M6.3 6.3a1.75 1.75 0 1 1 2.4 1.6c-.45.2-.7.55-.7 1v.35"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
          <circle cx="8" cy="11.3" r=".8" fill="currentColor" />
        </svg>
      </span>
    </span>
  )
}
