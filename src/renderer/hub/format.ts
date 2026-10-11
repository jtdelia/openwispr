export function dayLabel(timestamp: number): string {
  const date = new Date(timestamp)
  const today = new Date()
  const yesterday = new Date(Date.now() - 86_400_000)
  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

export function groupByDay<T>(items: T[], timestamp: (item: T) => number): Array<[string, T[]]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const label = dayLabel(timestamp(item))
    groups.set(label, [...(groups.get(label) ?? []), item])
  }
  return [...groups]
}

export function timeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

