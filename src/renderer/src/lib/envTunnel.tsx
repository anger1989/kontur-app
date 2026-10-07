import { useCallback, useState, type JSX, type ReactNode } from 'react'
import type { EnvConfig, TunnelState } from '@shared/types'
import { toast } from '@/components/ui/toast'
import { TextPromptDialog } from '@/components/prompts'
import { useStore } from '@/store'

export const TUNNEL_LABEL: Record<TunnelState, string> = {
  up: 'Контур доступен',
  down: 'Туннель не поднят',
  checking: 'Проверяем…',
  unknown: 'Проверка не настроена'
}

/** Нужен ли диалог кода (Indeed push на checkpoint — без диалога, ждём health). */
export function needsOtpDialog(env: EnvConfig): boolean {
  return env.vpn.requiresOtp && env.vpn.kind !== 'checkpoint'
}

/** VPN-контуры (+ с health-check), без «Общие». */
export function tunnelEnvs(envs: EnvConfig[] | undefined): EnvConfig[] {
  return (envs ?? []).filter(
    (e) => e.enabled && e.id !== 'shared' && (e.vpn.kind !== 'none' || e.healthCheckUrl)
  )
}

export function managedVpnEnvs(envs: EnvConfig[] | undefined): EnvConfig[] {
  return tunnelEnvs(envs).filter((e) => e.vpn.kind !== 'none')
}

/**
 * Общие действия «Подключить / Отключить / Проверить / Поднять оба» —
 * те же, что в настройках (EnvConnect).
 */
export function useEnvTunnelActions(): {
  busy: string | null
  probing: string | null
  probe: (env: EnvConfig) => Promise<void>
  connectOne: (env: EnvConfig) => Promise<boolean>
  disconnectOne: (env: EnvConfig) => Promise<void>
  connectAll: () => Promise<void>
  otpDialog: ReactNode
} {
  const { config, refreshStatuses } = useStore()
  const [busy, setBusy] = useState<string | null>(null)
  const [probing, setProbing] = useState<string | null>(null)
  const [otpAsk, setOtpAsk] = useState<{ env: EnvConfig; resolve: (code: string | null) => void } | null>(
    null
  )

  const managed = managedVpnEnvs(config?.envs)
  const multiCheckpoint = managed.filter((e) => e.vpn.kind === 'checkpoint').length > 1

  const askOtp = useCallback(
    (env: EnvConfig): Promise<string | null> =>
      new Promise((resolve) => setOtpAsk({ env, resolve })),
    []
  )

  const probe = useCallback(async (env: EnvConfig): Promise<void> => {
    setProbing(env.id)
    try {
      const all = await window.kontur.env.probe(env.id)
      useStore.setState({ statuses: all })
      const st = all.find((s) => s.envId === env.id)
      if (st?.tunnel === 'up') {
        toast.success(`«${env.name}» доступен`)
      } else if (st?.tunnel === 'down') {
        toast.error(`«${env.name}» недоступен`, {
          description: st.lastError ?? 'Адрес проверки не отвечает',
          duration: 8000
        })
      } else {
        toast.message(`«${env.name}»: ${TUNNEL_LABEL[st?.tunnel ?? 'unknown']}`)
      }
    } finally {
      setProbing((cur) => (cur === env.id ? null : cur))
    }
  }, [])

  const connectOne = useCallback(
    async (env: EnvConfig): Promise<boolean> => {
      let code: string | undefined
      if (needsOtpDialog(env)) {
        const entered = await askOtp(env)
        if (!entered) return false
        code = entered
      }
      setBusy(env.id)
      const toastId = toast.loading(
        env.vpn.kind === 'checkpoint' && env.vpn.requiresOtp
          ? `Поднимаем «${env.name}»… подтвердите Indeed`
          : `Поднимаем «${env.name}»…`
      )
      try {
        await window.kontur.vpn.connect(env.id, code)
        const verdict = await window.kontur.vpn.verifyAll()
        const othersDown = verdict.filter((v) => v.envId !== env.id && !v.up)
        if (othersDown.length && env.vpn.kind === 'checkpoint' && multiCheckpoint) {
          const names = othersDown
            .map((v) => config?.envs.find((e) => e.id === v.envId)?.name ?? v.envId)
            .join(', ')
          toast.success(`«${env.name}» поднят`, { id: toastId })
          toast.warning(`После этого недоступны: ${names}. Официальный CP держит один сайт.`, {
            duration: 10000
          })
        } else {
          toast.success(`«${env.name}» поднят`, { id: toastId })
        }
        return true
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e), { id: toastId, duration: 10000 })
        return false
      } finally {
        await refreshStatuses()
        setBusy(null)
      }
    },
    [askOtp, config?.envs, multiCheckpoint, refreshStatuses]
  )

  const disconnectOne = useCallback(
    async (env: EnvConfig): Promise<void> => {
      setBusy(env.id)
      const toastId = toast.loading(`Отключаем «${env.name}»…`)
      try {
        await window.kontur.vpn.disconnect(env.id)
        toast.success(`«${env.name}» отключён`, { id: toastId })
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e), { id: toastId, duration: 10000 })
      } finally {
        await refreshStatuses()
        setBusy(null)
      }
    },
    [refreshStatuses]
  )

  const connectAll = useCallback(async (): Promise<void> => {
    const otps: Record<string, string | undefined> = {}
    for (const env of managed) {
      if (needsOtpDialog(env)) {
        const entered = await askOtp(env)
        if (!entered) return
        otps[env.id] = entered
      }
    }
    setBusy('*')
    const toastId = toast.loading(
      managed.some((e) => e.vpn.kind === 'checkpoint' && e.vpn.requiresOtp)
        ? 'Поднимаем оба… подтвердите Indeed на банке'
        : 'Поднимаем оба контура…'
    )
    try {
      const verdict = await window.kontur.vpn.connectBoth(otps)
      const up = verdict.filter((v) => v.up)
      const down = verdict.filter((v) => !v.up)
      if (!down.length) toast.success('Все контуры подняты', { id: toastId })
      else if (up.length) {
        toast.warning(
          `Доступны: ${up
            .map((v) => config?.envs.find((e) => e.id === v.envId)?.name ?? v.envId)
            .join(', ')}. Не поднялись: ${down
            .map((v) => config?.envs.find((e) => e.id === v.envId)?.name ?? v.envId)
            .join(', ')}.`,
          { id: toastId, duration: 12000 }
        )
      } else toast.error('Ни один контур не доступен', { id: toastId })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e), { id: toastId, duration: 12000 })
    } finally {
      await refreshStatuses()
      setBusy(null)
    }
  }, [askOtp, config?.envs, managed, refreshStatuses])

  const otpDialog: JSX.Element = (
    <TextPromptDialog
      open={otpAsk !== null}
      title={`Код для контура «${otpAsk?.env.name ?? ''}»`}
      description="Логин и пароль подставятся сами. Введите одноразовый код — он нигде не сохраняется."
      label="Код"
      confirmLabel="Подключить"
      onConfirm={(code) => {
        otpAsk?.resolve(code)
        setOtpAsk(null)
      }}
      onOpenChange={(open) => {
        if (!open && otpAsk) {
          otpAsk.resolve(null)
          setOtpAsk(null)
        }
      }}
    />
  )

  return { busy, probing, probe, connectOne, disconnectOne, connectAll, otpDialog }
}
