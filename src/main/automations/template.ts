/** Подстановка {{key}} из контекста. Неизвестные ключи оставляем как есть. */

export function renderTemplate(input: string, ctx: Record<string, unknown>): string {
  return input.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (full, key: string) => {
    const v = lookup(ctx, key)
    if (v == null) return full
    return String(v)
  })
}

function lookup(ctx: Record<string, unknown>, key: string): unknown {
  if (Object.prototype.hasOwnProperty.call(ctx, key)) return ctx[key]
  const parts = key.split('.')
  let cur: unknown = ctx
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

/** Рекурсивно прогнать строки в params через шаблонизатор. */
export function renderParams(
  params: Record<string, unknown> | undefined,
  ctx: Record<string, unknown>
): Record<string, unknown> {
  if (!params) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string') out[k] = renderTemplate(v, ctx)
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = renderParams(v as Record<string, unknown>, ctx)
    } else out[k] = v
  }
  return out
}
