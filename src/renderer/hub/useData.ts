import { useCallback, useEffect, useRef, useState } from 'react'
import type { DataTopic } from '../../shared/api'

/** Loads a value and reloads it whenever the main process reports a change to one of `topics`. */
export function useData<T>(load: () => Promise<T>, topics: DataTopic[]): [T | null, () => void] {
  const [value, setValue] = useState<T | null>(null)
  const loadRef = useRef(load)
  loadRef.current = load
  const reload = useCallback(() => void loadRef.current().then(setValue), [])
  const topicKey = topics.join(',')

  useEffect(() => {
    reload()
    const subscribed = topicKey.split(',')
    return window.openwispr.onDataChanged((topic) => {
      if (subscribed.includes(topic)) reload()
    })
  }, [reload, topicKey])

  return [value, reload]
}
