/** Именованная PTY-сессия ассистента в main (общая для виджета и окна). */
export const ASSISTANT_SESSION_KEY = 'assistant'

/**
 * Какой `assistantRestartSeq` уже применён (kill+create).
 * Живёт на модуле, а не в ref компонента: иначе при развороте виджет→окно
 * новый mount снова видел бы restartToken>0 и убивал живую сессию.
 */
let appliedAssistantRestart = 0

export function takeAssistantRestart(seq: number): boolean {
  if (seq <= appliedAssistantRestart) return false
  appliedAssistantRestart = seq
  return true
}
