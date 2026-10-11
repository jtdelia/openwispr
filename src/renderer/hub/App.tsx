import { useState } from 'react'
import { DictionaryPage } from './pages/DictionaryPage'
import { HomePage } from './pages/HomePage'
import { NotetakerPage } from './pages/NotetakerPage'
import { SettingsPage } from './pages/SettingsPage'
import { SnippetsPage } from './pages/SnippetsPage'
import { StylePage } from './pages/StylePage'

export type Page = 'home' | 'notetaker' | 'dictionary' | 'snippets' | 'style' | 'settings'

const NAV: Array<{ page: Page; label: string }> = [
  { page: 'home', label: 'Home' },
  { page: 'notetaker', label: 'Notetaker' },
  { page: 'dictionary', label: 'Dictionary' },
  { page: 'snippets', label: 'Snippets' },
  { page: 'style', label: 'Style' },
  { page: 'settings', label: 'Settings' },
]

export function App() {
  const [page, setPage] = useState<Page>('home')

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" />
          OpenWispr
        </div>
        <nav>
          {NAV.map((item) => (
            <button
              key={item.page}
              className={`nav-item${page === item.page ? ' active' : ''}`}
              onClick={() => setPage(item.page)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="content">{renderPage(page, setPage)}</main>
    </div>
  )
}

function renderPage(page: Page, navigate: (page: Page) => void) {
  switch (page) {
    case 'home':
      return <HomePage navigate={navigate} />
    case 'notetaker':
      return <NotetakerPage />
    case 'dictionary':
      return <DictionaryPage />
    case 'snippets':
      return <SnippetsPage />
    case 'style':
      return <StylePage />
    case 'settings':
      return <SettingsPage />
    default: {
      const unreachable: never = page
      throw new Error(`unhandled page ${String(unreachable)}`)
    }
  }
}
