import { comboLabel } from '../../../shared/keycodes'
import { isLocalEndpoint, type HistoryEntry } from '../../../shared/types'
import type { Page } from '../App'
import { groupByDay, timeLabel } from '../format'
import { useData } from '../useData'

const api = window.openwispr

export function HomePage({ navigate }: { navigate: (page: Page) => void }) {
  const [settings] = useData(api.getSettings, ['settings'])
  const [stats] = useData(api.getStats, ['history'])
  const [history] = useData(api.getHistory, ['history'])
  const [permissions] = useData(api.getPermissions, ['permissions', 'settings'])

  const setupItems = [
    !permissions?.accessibility && 'Grant Accessibility access so OpenWispr can hear your shortcut and paste text',
    permissions && permissions.microphone !== 'granted' && 'Allow microphone access',
    settings &&
      !settings.transcription.hasApiKey &&
      !isLocalEndpoint(settings.transcription.baseUrl) &&
      'Add a transcription API key',
    permissions && !permissions.helperRunning && 'Build the native helper (npm run helper:build)',
  ].filter(Boolean) as string[]

  const ptt = settings ? comboLabel(settings.shortcuts.ptt) : 'fn'
  const handsFree = settings ? comboLabel(settings.shortcuts.handsFree) : 'fn + Space'

  return (
    <div className="page">
      <header className="page-header">
        <h1>Welcome back{settings?.userName ? `, ${settings.userName.split(' ')[0]}` : ''}</h1>
        <p className="muted">
          Hold <kbd>{ptt}</kbd> and speak in any app. Press <kbd>{handsFree}</kbd> for hands-free mode.
        </p>
      </header>

      {setupItems.length > 0 && (
        <section className="card setup">
          <h2>Finish setting up</h2>
          <ul>
            {setupItems.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <button className="button primary" onClick={() => navigate('settings')}>
            Open Settings
          </button>
        </section>
      )}

      <section className="stats">
        <div className="stat">
          <span className="stat-value">{stats?.totalWords.toLocaleString() ?? '–'}</span>
          <span className="stat-label">words dictated</span>
        </div>
        <div className="stat">
          <span className="stat-value">{stats?.averageWpm ?? '–'}</span>
          <span className="stat-label">words per minute</span>
        </div>
        <div className="stat">
          <span className="stat-value">{stats?.totalDictations.toLocaleString() ?? '–'}</span>
          <span className="stat-label">dictations</span>
        </div>
      </section>

      <section>
        <div className="section-title">
          <h2>History</h2>
          {history && history.length > 0 && (
            <button className="link" onClick={() => confirm('Delete all history?') && void api.clearHistory()}>
              Clear all
            </button>
          )}
        </div>
        {history?.length === 0 && <p className="muted empty">Your dictations will show up here.</p>}
        {groupByDay(history ?? [], (entry) => entry.timestamp).map(([label, entries]) => (
          <div key={label} className="history-group">
            <h3>{label}</h3>
            <div className="card list">
              {entries.map((entry) => (
                <HistoryRow key={entry.id} entry={entry} />
              ))}
            </div>
          </div>
        ))}
      </section>
    </div>
  )
}

function HistoryRow({ entry }: { entry: HistoryEntry }) {
  const time = timeLabel(entry.timestamp)
  const text = entry.formattedText || entry.asrText
  return (
    <div className={`history-row status-${entry.status}`}>
      <span className="history-time">{time}</span>
      <div className="history-body">
        {text ? <p>{text}</p> : <p className="muted">No speech detected</p>}
        {entry.error && <p className="error-text">{entry.error}</p>}
        <span className="history-meta">
          {entry.appName || 'Unknown app'}
          {entry.status === 'copied' && ' · copied to clipboard'}
          {entry.mode === 'handsFree' && ' · hands-free'}
        </span>
      </div>
      <div className="row-actions">
        {text && (
          <button className="link" onClick={() => void api.copyText(text)}>
            Copy
          </button>
        )}
        <button className="link danger" onClick={() => void api.deleteHistoryEntry(entry.id)}>
          Delete
        </button>
      </div>
    </div>
  )
}
