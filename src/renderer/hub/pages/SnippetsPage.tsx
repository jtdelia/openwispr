import { useState, type FormEvent } from 'react'
import { useData } from '../useData'

const api = window.openwispr

export function SnippetsPage() {
  const [snippets] = useData(api.getSnippets, ['snippets'])
  const [trigger, setTrigger] = useState('')
  const [expansion, setExpansion] = useState('')

  const add = (event: FormEvent) => {
    event.preventDefault()
    if (!trigger.trim() || !expansion || !snippets) return
    void api.saveSnippets([{ id: crypto.randomUUID(), trigger: trigger.trim(), expansion }, ...snippets])
    setTrigger('')
    setExpansion('')
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Snippets</h1>
        <p className="muted">Say a trigger phrase and OpenWispr types the full text: links, addresses, sign-offs.</p>
      </header>

      <form className="card form-stack" onSubmit={add}>
        <input placeholder="Trigger, e.g. my calendar link" value={trigger} onChange={(e) => setTrigger(e.target.value)} />
        <textarea
          placeholder="Expansion, e.g. https://cal.com/you"
          rows={3}
          value={expansion}
          onChange={(e) => setExpansion(e.target.value)}
        />
        <div>
          <button className="button primary" type="submit" disabled={!trigger.trim() || !expansion}>
            Add snippet
          </button>
        </div>
      </form>

      {snippets?.length === 0 && <p className="muted empty">No snippets yet.</p>}
      {snippets && snippets.length > 0 && (
        <div className="card list">
          {snippets.map((snippet) => (
            <div key={snippet.id} className="list-row">
              <div className="snippet">
                <strong>“{snippet.trigger}”</strong>
                <span className="snippet-expansion">{snippet.expansion}</span>
              </div>
              <button
                className="link danger"
                onClick={() => void api.saveSnippets(snippets.filter((s) => s.id !== snippet.id))}
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
