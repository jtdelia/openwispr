import { useEffect, useState } from 'react'
import { comboLabel, MODIFIER_KEYS } from '../../../shared/keycodes'
import { microphoneHelp } from '../../../shared/permissions'
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_LABELS,
  type PublicSettings,
  type SettingsPatch,
  type ShortcutAction,
} from '../../../shared/types'
import { useData } from '../useData'

const api = window.openwispr

interface Preset {
  label: string
  baseUrl: string
  transcriptionModel: string
  cleanupModel: string
}

const PRESETS: Preset[] = [
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', transcriptionModel: 'gpt-4o-mini-transcribe', cleanupModel: 'gpt-4.1-mini' },
  { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', transcriptionModel: 'whisper-large-v3-turbo', cleanupModel: 'llama-3.3-70b-versatile' },
  { label: 'Local (Speaches / faster-whisper)', baseUrl: 'http://localhost:8000/v1', transcriptionModel: 'Systran/faster-distil-whisper-large-v3', cleanupModel: '' },
]

const update = (patch: SettingsPatch) => void api.updateSettings(patch)

export function SettingsPage() {
  const [settings] = useData(api.getSettings, ['settings'])
  const [permissions] = useData(api.getPermissions, ['permissions'])
  const [micHelp, setMicHelp] = useState<string | null>(null)
  if (!settings) return null

  return (
    <div className="page">
      <header className="page-header">
        <h1>Settings</h1>
      </header>

      <section className="card settings-section">
        <h2>Permissions</h2>
        <SettingRow
          title="Accessibility"
          description="Detects your dictation shortcut and pastes text into the focused app."
        >
          {permissions?.accessibility ? (
            <span className="badge ok">Granted</span>
          ) : (
            <button className="button" onClick={() => void api.requestAccessibility()}>
              Grant access
            </button>
          )}
        </SettingRow>
        <SettingRow title="Microphone" description="Records audio while you dictate.">
          {permissions?.microphone === 'granted' ? (
            <span className="badge ok">Granted</span>
          ) : (
            <button
              className="button"
              onClick={() => void api.requestMicrophone().then((status) => setMicHelp(microphoneHelp(status.microphone)))}
            >
              Allow
            </button>
          )}
        </SettingRow>
        {micHelp && permissions?.microphone !== 'granted' && <p className="error-text small">{micHelp}</p>}
        {permissions && !permissions.helperRunning && (
          <p className="error-text">The native helper isn’t running. Build it with npm run helper:build and restart.</p>
        )}
      </section>

      <ProviderSection settings={settings} />

      <section className="card settings-section">
        <h2>Shortcuts</h2>
        {(Object.keys(SHORTCUT_LABELS) as ShortcutAction[]).map((action) => (
          <ShortcutRow key={action} action={action} settings={settings} />
        ))}
        <p className="muted small">
          Tip: if fn opens the emoji picker, set System Settings → Keyboard → “Press 🌐 key to” → “Do Nothing”.
        </p>
      </section>

      <section className="card settings-section">
        <h2>Microphone</h2>
        <MicrophonePicker value={settings.microphoneId} />
      </section>

      <section className="card settings-section">
        <h2>General</h2>
        <SettingRow title="Your name" description="Helps with spelling and sign-offs.">
          <TextSetting value={settings.userName} placeholder="Jane Doe" onSave={(userName) => update({ userName })} />
        </SettingRow>
        <Toggle title="Sound effects" checked={settings.sounds} onChange={(sounds) => update({ sounds })} />
        <Toggle
          title="Show Flow bar while idle"
          description="The small pill at the bottom of the screen. It always appears while dictating."
          checked={settings.showFlowBar}
          onChange={(showFlowBar) => update({ showFlowBar })}
        />
        <Toggle
          title="Restore clipboard after pasting"
          checked={settings.restoreClipboard}
          onChange={(restoreClipboard) => update({ restoreClipboard })}
        />
        <Toggle
          title="Launch at login"
          checked={settings.launchAtLogin}
          onChange={(launchAtLogin) => update({ launchAtLogin })}
        />
      </section>
    </div>
  )
}

function ProviderSection({ settings }: { settings: PublicSettings }) {
  const { transcription, cleanup } = settings
  const applyPreset = (label: string) => {
    const preset = PRESETS.find((p) => p.label === label)
    if (!preset) return
    update({
      transcription: { baseUrl: preset.baseUrl, model: preset.transcriptionModel },
      cleanup: preset.cleanupModel
        ? { baseUrl: preset.baseUrl, model: preset.cleanupModel }
        : { enabled: false },
    })
  }
  const activePreset = PRESETS.find((p) => p.baseUrl === transcription.baseUrl)?.label ?? 'Custom'

  return (
    <>
      <section className="card settings-section">
        <h2>Transcription</h2>
        <p className="muted small">Any OpenAI-compatible speech-to-text endpoint.</p>
        <SettingRow title="Provider">
          <select value={activePreset} onChange={(e) => applyPreset(e.target.value)}>
            {PRESETS.map((p) => (
              <option key={p.label}>{p.label}</option>
            ))}
            <option disabled>Custom</option>
          </select>
        </SettingRow>
        <SettingRow title="Base URL">
          <TextSetting value={transcription.baseUrl} onSave={(baseUrl) => update({ transcription: { baseUrl } })} />
        </SettingRow>
        <SettingRow title="Model">
          <TextSetting value={transcription.model} onSave={(model) => update({ transcription: { model } })} />
        </SettingRow>
        <SettingRow title="API key">
          <SecretSetting hasValue={transcription.hasApiKey} onSave={(apiKey) => update({ transcription: { apiKey } })} />
        </SettingRow>
        <SettingRow title="Language" description="ISO code like en or de. Leave empty to auto-detect.">
          <TextSetting
            value={transcription.language}
            placeholder="auto"
            onSave={(language) => update({ transcription: { language } })}
          />
        </SettingRow>
      </section>

      <section className="card settings-section">
        <h2>AI cleanup</h2>
        <Toggle
          title="Clean up transcripts with an LLM"
          description="Removes filler words, applies self-corrections, fixes punctuation and matches your style."
          checked={cleanup.enabled}
          onChange={(enabled) => update({ cleanup: { enabled } })}
        />
        {cleanup.enabled && (
          <>
            <SettingRow title="Base URL" description="OpenAI-compatible chat completions endpoint.">
              <TextSetting value={cleanup.baseUrl} onSave={(baseUrl) => update({ cleanup: { baseUrl } })} />
            </SettingRow>
            <SettingRow title="Model">
              <TextSetting value={cleanup.model} onSave={(model) => update({ cleanup: { model } })} />
            </SettingRow>
            <SettingRow
              title="API key"
              description={cleanup.baseUrl === transcription.baseUrl ? 'Uses the transcription key when left empty.' : undefined}
            >
              <SecretSetting hasValue={cleanup.hasApiKey} onSave={(apiKey) => update({ cleanup: { apiKey } })} />
            </SettingRow>
          </>
        )}
      </section>
    </>
  )
}

function ShortcutRow({ action, settings }: { action: ShortcutAction; settings: PublicSettings }) {
  const [capturing, setCapturing] = useState(false)
  const [preview, setPreview] = useState<number[]>([])

  useEffect(() => {
    if (!capturing) return
    let combo = new Set<number>()
    void api.startShortcutCapture()
    const unsubscribe = api.onShortcutCapture((held) => {
      if (held.length > 0) {
        combo = new Set([...combo, ...held])
        setPreview([...combo])
        return
      }
      const keys = [...combo]
      const valid = keys.length > 0 && (action === 'ptt' || keys.some((k) => !MODIFIER_KEYS.has(k)) || keys.length > 1)
      if (valid) update({ shortcuts: { ...settings.shortcuts, [action]: keys } })
      setCapturing(false)
    })
    return () => {
      unsubscribe()
      void api.stopShortcutCapture()
    }
  }, [capturing, action, settings.shortcuts])

  const current = settings.shortcuts[action]
  const isDefault = comboLabel(current) === comboLabel(DEFAULT_SHORTCUTS[action])

  return (
    <SettingRow title={SHORTCUT_LABELS[action]}>
      <div className="shortcut">
        <kbd className={capturing ? 'capturing' : ''}>
          {capturing ? (preview.length ? comboLabel(preview) : 'Press keys…') : comboLabel(current) || 'None'}
        </kbd>
        {capturing ? (
          <button className="link" onClick={() => setCapturing(false)}>
            Cancel
          </button>
        ) : (
          <button
            className="link"
            onClick={() => {
              setPreview([])
              setCapturing(true)
            }}
          >
            Change
          </button>
        )}
        {!capturing && !isDefault && (
          <button
            className="link"
            onClick={() => update({ shortcuts: { ...settings.shortcuts, [action]: DEFAULT_SHORTCUTS[action] } })}
          >
            Reset
          </button>
        )}
      </div>
    </SettingRow>
  )
}

function MicrophonePicker({ value }: { value: string }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])

  useEffect(() => {
    const load = () =>
      void navigator.mediaDevices
        .enumerateDevices()
        .then((all) => setDevices(all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default')))
    load()
    navigator.mediaDevices.addEventListener('devicechange', load)
    return () => navigator.mediaDevices.removeEventListener('devicechange', load)
  }, [])

  return (
    <SettingRow title="Input device">
      <select value={value} onChange={(e) => update({ microphoneId: e.target.value })}>
        <option value="">System default</option>
        {devices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || 'Microphone'}
          </option>
        ))}
      </select>
    </SettingRow>
  )
}

function SettingRow({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="setting-row">
      <div>
        <div className="setting-title">{title}</div>
        {description && <div className="muted small">{description}</div>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  )
}

function Toggle(props: { title: string; description?: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <SettingRow title={props.title} description={props.description}>
      <label className="switch">
        <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
        <span />
      </label>
    </SettingRow>
  )
}

function TextSetting(props: { value: string; placeholder?: string; onSave: (value: string) => void }) {
  const [draft, setDraft] = useState(props.value)
  useEffect(() => setDraft(props.value), [props.value])
  const commit = () => draft.trim() !== props.value && props.onSave(draft.trim())
  return (
    <input
      value={draft}
      placeholder={props.placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  )
}

function SecretSetting({ hasValue, onSave }: { hasValue: boolean; onSave: (value: string) => void }) {
  const [draft, setDraft] = useState('')
  const save = () => {
    if (!draft.trim()) return
    onSave(draft.trim())
    setDraft('')
  }
  return (
    <div className="secret">
      <input
        type="password"
        value={draft}
        placeholder={hasValue ? '•••••••• saved' : 'sk-…'}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && save()}
      />
      {draft ? (
        <button className="button" onClick={save}>
          Save
        </button>
      ) : (
        hasValue && (
          <button className="link danger" onClick={() => onSave('')}>
            Remove
          </button>
        )
      )}
    </div>
  )
}
