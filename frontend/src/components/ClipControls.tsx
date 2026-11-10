import type { RefObject } from 'react'
import { clock } from '../lib/time'

export default function ClipControls({
  playing,
  position,
  length,
  onToggle,
  onSeek,
  fullscreenTarget,
}: {
  playing: boolean
  position: number
  length: number
  onToggle: () => void
  onSeek: (seconds: number) => void
  fullscreenTarget: RefObject<HTMLElement | null>
}) {
  return (
    <div className="absolute inset-x-0 bottom-0 flex items-center gap-3 rounded-b-2xl bg-gradient-to-t from-black/80 to-transparent px-4 pb-3 pt-8 text-sm text-white">
      <button onClick={onToggle} aria-label={playing ? 'Pause clip' : 'Play clip'} className="grid h-8 w-8 shrink-0 place-items-center rounded-full hover:bg-white/10">
        <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden>
          {playing ? <path d="M7 5h3v14H7zM14 5h3v14h-3z" /> : <path d="M8 5.5v13l10-6.5z" />}
        </svg>
      </button>
      <input
        type="range"
        min={0}
        max={length}
        step={0.1}
        value={position}
        onChange={(e) => onSeek(Number(e.target.value))}
        aria-label="Clip position"
        className="h-1 min-w-0 flex-1 cursor-pointer accent-amber-400"
      />
      <span className="shrink-0 tabular-nums text-zinc-200">
        {clock(position)} / {clock(length)}
      </span>
      <button
        onClick={() => (document.fullscreenElement ? document.exitFullscreen() : fullscreenTarget.current?.requestFullscreen())}
        aria-label="Full screen"
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full hover:bg-white/10"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
        </svg>
      </button>
    </div>
  )
}
