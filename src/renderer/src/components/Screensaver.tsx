import type { JSX } from 'react'
import { WavyBackground } from '@/components/ui/wavy-background'
import { TextGenerateEffect } from '@/components/ui/text-generate-effect'

/** Заставка простоя — тот же wavy, что у экрана загрузки. */
export function Screensaver({
  displayName,
  onWake
}: {
  displayName: string
  onWake: () => void
}): JSX.Element {
  const name = displayName.trim() || 'Kontur'
  return (
    <button
      type="button"
      className="fixed inset-0 z-[200000] cursor-default border-0 bg-transparent p-0"
      onClick={onWake}
      onKeyDown={onWake}
      onPointerMove={onWake}
    >
      <WavyBackground
        containerClassName="h-full w-full"
        backgroundFill="#17181c"
        colors={['#f09a05', '#f2b43d', '#ffffff', '#fcd34d', '#f09a05']}
        waveWidth={40}
        waveOpacity={0.4}
        blur={8}
        speed="slow"
      >
        <div className="flex flex-col items-center gap-3">
          <TextGenerateEffect
            words={name}
            className="font-sans text-[36px] font-semibold tracking-tight text-white"
            duration={0.5}
          />
          <p className="text-[13px] text-white/45">Двиньте мышь или нажмите клавишу</p>
        </div>
      </WavyBackground>
    </button>
  )
}
