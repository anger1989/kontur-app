import type { JSX, SVGProps } from 'react'
import {
  AnthropicDark,
  AnthropicLight,
  ClaudeAI,
  CursorDark,
  CursorLight,
  OpenAIDark,
  OpenAILight
} from '@ridemountainpig/svgl-react'
import { Bot } from 'lucide-react'
import { useStore } from '@/store'

/**
 * Фирменные логотипы из svgl.
 *
 * Применяем их там, где логотип действительно различает сущности — в списке
 * локальных AI-агентов. Для сервисов контуров он не годится: у всех продуктов
 * Atlassian логотип один и тот же, и список становится нечитаемым, поэтому там
 * остаются линейные иконки lucide.
 */

type SvgComponent = (props: SVGProps<SVGSVGElement>) => JSX.Element

/** Логотип агента по его id. Тёмная и светлая версии — под текущую тему. */
export function AgentIcon({
  id,
  size = 18
}: {
  id: string
  size?: number
}): JSX.Element {
  const dark = useStore((s) => s.resolvedTheme) === 'dark'

  const pick: Record<string, SvgComponent | undefined> = {
    cursor: dark ? CursorLight : CursorDark,
    'claude-code': ClaudeAI,
    'claude-desktop': ClaudeAI,
    codex: dark ? OpenAILight : OpenAIDark,
    anthropic: dark ? AnthropicLight : AnthropicDark
  }

  const Svg = pick[id]
  if (Svg) return <Svg width={size} height={size} />
  return <Bot size={size} />
}
