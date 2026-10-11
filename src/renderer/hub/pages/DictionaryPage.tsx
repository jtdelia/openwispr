import { useState, type FormEvent } from 'react'
import { useData } from '../useData'

const api = window.openwispr

export function DictionaryPage() {
  const [entries] = useData(api.getDictionary, ['dictionary'])
  const [word, setWord] = useState('')
  const [replaces, setReplaces] = useState('')

  const add = (event: FormEvent) => {
    event.preventDefault()
    if (!word.trim() || !entries) return
    void api.saveDictionary([
      { id: crypto.randomUUID(), word: word.trim(), replaces: replaces.trim() || undefined },
      ...entries,
    ])
    setWord('')
    setReplaces('')
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Dictionary</h1>
        <p className="muted">
          Names, jargon and acronyms OpenWispr should spell your way. Add what it mishears to replace it
          automatically.
        </p>
      </header>

      <form className="card form-row" onSubmit={add}>
        <input placeholder="Word or phrase, e.g. Kubernetes" value={word} onChange={(e) => setWord(e.target.value)} />
        <input
          placeholder="Optional: replaces, e.g. cooper netties"
          value={replaces}
          onChange={(e) => setReplaces(e.target.value)}
        />
        <button className="button primary" type="submit" disabled={!word.trim()}>
          Add
        </button>
      </form>

      {entries?.length === 0 && <p className="muted empty">No words yet.</p>}
      {entries && entries.length > 0 && (
        <div className="card list">
          {entries.map((entry) => (
            <div key={entry.id} className="list-row">
              <div>
                <strong>{entry.word}</strong>
                {entry.replaces && <span className="muted"> ← {entry.replaces}</span>}
              </div>
              <button
                className="link danger"
                onClick={() => void api.saveDictionary(entries.filter((e) => e.id !== entry.id))}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
