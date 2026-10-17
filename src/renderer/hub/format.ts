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

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes < 1e10 ? 2 : 1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return `${Math.max(0, Math.round(bytes / 1e3))} KB`
}

export function percent(done: number, total: number): number {
  return total > 0 ? Math.floor((done / total) * 100) : 0
}

export function timeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

