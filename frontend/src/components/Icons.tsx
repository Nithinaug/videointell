const base = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }

export function UploadIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <path d="M12 16V4M6 10l6-6 6 6M4 20h16" />
    </svg>
  )
}

export function ShareIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M14 4.5v4.1C7.6 9 4.1 12.6 3 19.5c2.3-3.4 5.9-5 11-5v4.1L21.5 11.5 14 4.5z" />
    </svg>
  )
}

export function TrashIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
    </svg>
  )
}

export function SignOutIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4" />
    </svg>
  )
}

export function HomeIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <path d="M3 11l9-7 9 7M5 9.5V20h5v-6h4v6h5V9.5" />
    </svg>
  )
}

export function CheckIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <path d="M5 12l5 5 9-10" />
    </svg>
  )
}
