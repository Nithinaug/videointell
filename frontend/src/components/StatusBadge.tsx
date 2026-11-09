const STYLES: Record<string, { chip: string; dot: string; label: string; live?: boolean }> = {
  uploading: { chip: 'bg-white/5 text-slate-300 ring-white/10', dot: 'bg-slate-400', label: 'Uploading', live: true },
  uploaded: { chip: 'bg-zinc-400/10 text-zinc-200 ring-zinc-400/25', dot: 'bg-zinc-400', label: 'Queued', live: true },
  processing: { chip: 'bg-amber-400/10 text-amber-200 ring-amber-400/25', dot: 'bg-amber-400', label: 'Processing', live: true },
  ready: { chip: 'bg-emerald-400/10 text-emerald-200 ring-emerald-400/25', dot: 'bg-emerald-400', label: 'Ready' },
  failed: { chip: 'bg-red-400/10 text-red-200 ring-red-400/25', dot: 'bg-red-400', label: 'Failed' },
}

export default function StatusBadge({ status }: { status: string }) {
  const s = STYLES[status] ?? STYLES.uploading
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 backdrop-blur ${s.chip}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot} ${s.live ? 'pulse-dot' : ''}`} />
      {s.label}
    </span>
  )
}
