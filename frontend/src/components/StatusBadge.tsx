const STYLES: Record<string, { chip: string; dot: string; label: string; live?: boolean }> = {
  uploading: { chip: 'bg-subtle text-ink-muted ring-border-subtle', dot: 'bg-ink-muted', label: 'Uploading', live: true },
  uploaded: { chip: 'bg-subtle text-ink-muted ring-border-subtle', dot: 'bg-ink-muted', label: 'Queued', live: true },
  processing: { chip: 'bg-subtle text-ink-muted ring-border-subtle', dot: 'bg-accent', label: 'Processing', live: true },
  failed: { chip: 'bg-subtle text-ink-muted ring-border-subtle', dot: 'bg-danger', label: 'Failed' },
}

export default function StatusBadge({ status }: { status: string }) {
  if (status === 'ready') return null
  const s = STYLES[status] ?? STYLES.uploading
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-inner px-2.5 py-1 text-[11px] font-semibold ring-1 backdrop-blur ${s.chip}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot} ${s.live ? 'pulse-dot' : ''}`} />
      {s.label}
    </span>
  )
}
