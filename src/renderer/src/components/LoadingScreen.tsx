import type { JSX } from 'react'
import { WavyBackground } from '@/components/ui/wavy-background'
import { TextGenerateEffect } from '@/components/ui/text-generate-effect'

/**
 * Экран загрузки / приветствия — старт приложения и финал онбординга.
 * Брендовые цвета: графит фона + оранжевый акцент.
 */
export function LoadingScreen({
  message = 'Собираем контуры…'
}: {
  message?: string
}): JSX.Element {
  return (
    <WavyBackground
      containerClassName="h-full"
      backgroundFill="#17181c"
      colors={['#f09a05', '#f2b43d', '#ffffff', '#fcd34d', '#f09a05']}
      waveWidth={40}
      waveOpacity={0.4}
      blur={8}
      speed="slow"
    >
      <div className="flex flex-col items-center gap-3">
        <TextGenerateEffect
          words="Kontur"
          className="font-sans text-[40px] font-semibold tracking-tight text-white"
          duration={0.4}
        />
        <TextGenerateEffect
          words={message}
          className="text-[13px] font-normal text-white/60"
          duration={0.45}
        />
      </div>
    </WavyBackground>
  )
}
