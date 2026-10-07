import type { KonturApi } from './index'

declare global {
  interface Window {
    kontur: KonturApi
  }
}

export {}
