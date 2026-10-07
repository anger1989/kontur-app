import { app } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const configFile = (): string => join(app.getPath('userData'), 'config.json')
export const secretsFile = (): string => join(app.getPath('userData'), 'secrets.json')
export const dbFile = (): string => join(app.getPath('userData'), 'kontur.db')

/** Хранилище заметок по умолчанию — обычная папка, которую можно синкать чем угодно. */
export const defaultVaultPath = (): string => join(homedir(), 'Documents', 'Kontur Vault')
