const STYLES: Record<string, string> = {
  uploading: 'bg-[#334155]/30 text-slate-300',
  uploaded: 'bg-[#38BDF8]/15 text-sky-300',
  processing: 'bg-[#F59E0B]/15 text-amber-300',
  ready: 'bg-[#10B981]/15 text-emerald-300',
  failed: 'bg-[#EF4444]/15 text-red-300',
}

const LABELS: Record<string, string> = {
  uploading: 'Uploading',
  uploaded: 'Uploaded',
  processing: 'Processing',
  ready: 'Ready',
  failed: 'Failed',
}

export default function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`px-2.5 py-0.5 rounded-md text-[11px] font-bold ${STYLES[status] ?? 'bg-[#334155]/30 text-slate-300'}`}>
      {LABELS[status] ?? status}
    </span>
  )
}
