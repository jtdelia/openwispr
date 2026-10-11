import { STYLE_CONTEXTS, STYLES, type Style, type StyleContext } from '../../../shared/types'
import { useData } from '../useData'

const api = window.openwispr

const CONTEXT_INFO: Record<StyleContext, { title: string; apps: string }> = {
  personal: { title: 'Personal messages', apps: 'Messages, WhatsApp, Telegram, Signal, Discord' },
  work: { title: 'Work messages', apps: 'Slack, Microsoft Teams' },
  email: { title: 'Email', apps: 'Mail, Outlook, Superhuman, Gmail' },
  other: { title: 'Everything else', apps: 'Docs, notes, AI chats, code editors' },
}

const STYLE_INFO: Record<Style, { title: string; sample: string }> = {
  formal: { title: 'Formal', sample: 'Hey, are you free for lunch tomorrow? Let’s do 12 if that works for you.' },
  casual: { title: 'Casual', sample: 'Hey are you free for lunch tomorrow? Let’s do 12 if that works for you' },
  veryCasual: { title: 'Very casual', sample: 'hey are you free for lunch tomorrow? let’s do 12 if that works for you' },
  excited: { title: 'Excited', sample: 'Hey, are you free for lunch tomorrow? Let’s do 12 if that works for you!' },
}

export function StylePage() {
  const [settings] = useData(api.getSettings, ['settings'])

  return (
    <div className="page">
      <header className="page-header">
        <h1>Style</h1>
        <p className="muted">
          OpenWispr adapts punctuation and tone to the app you’re dictating into. Requires AI cleanup in Settings.
        </p>
      </header>
      {settings &&
        STYLE_CONTEXTS.map((context) => (
          <section key={context} className="style-section">
            <div className="section-title">
              <h2>{CONTEXT_INFO[context].title}</h2>
              <span className="muted small">{CONTEXT_INFO[context].apps}</span>
            </div>
            <div className="style-grid">
              {STYLES.map((style) => (
                <button
                  key={style}
                  className={`style-card${settings.styles[context] === style ? ' selected' : ''}`}
                  onClick={() => void api.updateSettings({ styles: { [context]: style } })}
                >
                  <strong>{STYLE_INFO[style].title}</strong>
                  <span>{STYLE_INFO[style].sample}</span>
                </button>
              ))}
            </div>
          </section>
        ))}
    </div>
  )
}
