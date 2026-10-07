import {
  BookText,
  CalendarDays,
  GitBranch,
  GitPullRequest,
  Globe,
  ListTodo,
  Mail,
  MessageSquare,
  Video,
  type LucideIcon
} from 'lucide-react'

/** Иконка по типу сервиса. Один набор на всё приложение — lucide. */
export function serviceIcon(kind: string): LucideIcon {
  switch (kind) {
    case 'jira':
      return ListTodo
    case 'confluence':
      return BookText
    case 'gitlab':
      return GitBranch
    case 'bitbucket':
      return GitPullRequest
    case 'mattermost':
    case 'achat':
      return MessageSquare
    case 'ktalk':
      return Video
    case 'mail':
      return Mail
    case 'calendar':
      return CalendarDays
    default:
      return Globe
  }
}
