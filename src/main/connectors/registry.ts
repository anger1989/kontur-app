import type { ServiceKind } from '@shared/types'
import type { Connector } from './types'
import { mattermostConnector } from './mattermost'
import { jiraConnector } from './jira'
import { confluenceConnector } from './confluence'
import { gitlabConnector } from './gitlab'
import { bitbucketConnector } from './bitbucket'
import { mailConnector } from './exchange'

/** Коннекторы по типу сервиса. Сервис без коннектора живёт только как вкладка. */
const CONNECTORS: Partial<Record<ServiceKind, Connector>> = {
  mattermost: mattermostConnector,
  jira: jiraConnector,
  confluence: confluenceConnector,
  gitlab: gitlabConnector,
  bitbucket: bitbucketConnector,
  mail: mailConnector
}

export function connectorFor(kind: ServiceKind): Connector | undefined {
  return CONNECTORS[kind]
}
