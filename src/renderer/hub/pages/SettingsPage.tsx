import { useEffect, useState } from 'react'
import { comboLabel, MODIFIER_KEYS } from '../../../shared/keycodes'
import { microphoneHelp } from '../../../shared/permissions'
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_LABELS,
  type BuiltInStatus,
  type EndpointTestResult,
  type ModelProgress,
  type ModelRole,
  type PublicModelSelection,
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

const APPLE_OPTION = 'Apple (on this Mac)'

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
  const { speechToText, chat, cleanup } = settings
  const isAppleSpeech = speechToText.kind === 'builtIn' && speechToText.modelId === 'apple'
  const applyPreset = (label: string) => {
    if (label === APPLE_OPTION) {
      update({ speechToText: { kind: 'builtIn', modelId: 'apple' } })
      return
    }
    const preset = PRESETS.find((p) => p.label === label)
    if (!preset) return
    update({
      speechToText: { kind: 'endpoint', baseUrl: preset.baseUrl, model: preset.transcriptionModel },
      ...(preset.cleanupModel
        ? { chat: { kind: 'endpoint', baseUrl: preset.baseUrl, model: preset.cleanupModel } }
        : { cleanup: { enabled: false } }),
    })
  }
  const activePreset = isAppleSpeech
    ? APPLE_OPTION
    : (speechToText.kind === 'endpoint' && PRESETS.find((p) => p.baseUrl === speechToText.baseUrl)?.label) || 'Custom'

  return (
    <>
      <section className="card settings-section">
        <h2>Speech-to-text</h2>
        <p className="muted small">Apple’s on-device model, or any OpenAI-compatible speech-to-text Endpoint.</p>
        <SettingRow title="Provider">
          <select value={activePreset} onChange={(e) => applyPreset(e.target.value)}>
            <option>{APPLE_OPTION}</option>
            {PRESETS.map((p) => (
              <option key={p.label}>{p.label}</option>
            ))}
            <option disabled>Custom</option>
          </select>
        </SettingRow>
        <SelectionSettings role="speechToText" selection={speechToText} />
        <SettingRow
          title="Language"
          description={
            isAppleSpeech
              ? 'ISO code like en or de. Leave empty to use your Mac’s language.'
              : 'ISO code like en or de. Leave empty to auto-detect.'
          }
        >
          <TextSetting value={settings.language} placeholder="auto" onSave={(language) => update({ language })} />
        </SettingRow>
        {isAppleSpeech && <AppleSpeechStatus language={settings.language} />}
      </section>

      <section className="card settings-section">
        <h2>Chat</h2>
        <p className="muted small">Cleans up dictations and writes meeting titles and summaries.</p>
        <Toggle
          title="Clean up dictations"
          description="Removes filler words, applies self-corrections, fixes punctuation and matches your style."
          checked={cleanup.enabled}
          onChange={(enabled) => update({ cleanup: { enabled } })}
        />
        <SelectionSettings
          role="chat"
          selection={chat}
          keyDescription={
            chat.kind === 'endpoint' && speechToText.kind === 'endpoint' && chat.baseUrl === speechToText.baseUrl
              ? 'Uses the speech-to-text key when left empty.'
              : undefined
          }
        />
      </section>
    </>
  )
}

function SelectionSettings(props: { role: ModelRole; selection: PublicModelSelection; keyDescription?: string }) {
  const { role, selection } = props
  switch (selection.kind) {
    case 'builtIn':
      if (role === 'speechToText' && selection.modelId === 'apple') {
        return (
          <SettingRow title="Model" description="Apple’s on-device speech-to-text. Your audio never leaves this Mac.">
            <span className="badge ok">Built-in</span>
          </SettingRow>
        )
      }
      return (
        <SettingRow title="Model" description="This Built-in model isn’t available yet.">
          <button className="button" onClick={() => update({ [role]: { kind: 'endpoint' } })}>
            Use an Endpoint
          </button>
        </SettingRow>
      )
    case 'endpoint':
      return (
        <>
          <SettingRow title="Base URL">
            <TextSetting value={selection.baseUrl} onSave={(baseUrl) => update({ [role]: { kind: 'endpoint', baseUrl } })} />
          </SettingRow>
          <SettingRow title="Model">
            <TextSetting value={selection.model} onSave={(model) => update({ [role]: { kind: 'endpoint', model } })} />
          </SettingRow>
          <SettingRow title="API key" description={props.keyDescription}>
            <SecretSetting
              hasValue={selection.hasApiKey}
              onSave={(apiKey) => update({ [role]: { kind: 'endpoint', apiKey } })}
            />
          </SettingRow>
          <EndpointTest role={role} />
        </>
      )
    default: {
      const unreachable: never = selection
      throw new Error(`unhandled model selection ${JSON.stringify(unreachable)}`)
    }
  }
}

const languageNames = new Intl.DisplayNames(undefined, { type: 'language' })

function languageName(code: string): string {
  if (!code) return 'your Mac’s language'
  try {
    return languageNames.of(code) ?? code
  } catch {
    return code
  }
}

/** Whether Apple supports the language setting, and its language-asset downloads as they run. */
function AppleSpeechStatus({ language }: { language: string }) {
  const [status, setStatus] = useState<BuiltInStatus | { error: string } | null>(null)
  const [download, setDownload] = useState<ModelProgress | null>(null)

  useEffect(() => {
    let current = true
    void api.getBuiltInStatus().then(
      (next) => current && setStatus(next),
      (error: unknown) => current && setStatus({ error: error instanceof Error ? error.message : String(error) }),
    )
    return () => {
      current = false
    }
  }, [language])

  useEffect(
    () =>
      api.onModelProgress((progress) => {
        if (progress.kind === 'appleSpeechAssets') setDownload(progress.fraction < 1 ? progress : null)
      }),
    [],
  )

  const downloadNotice = download && (
    <p className="muted small">
      Downloading Apple’s speech-to-text for {download.locale}… {Math.round(download.fraction * 100)}%
    </p>
  )
  if (status === null) return downloadNotice
  if ('error' in status) return <p className="error-text small">Couldn’t check Apple’s speech-to-text: {status.error}</p>
  const { appleSpeech } = status
  if (!appleSpeech.available) return <p className="error-text small">{appleSpeech.reason}</p>
  if (appleSpeech.locale === null) {
    const supported = [...new Set(appleSpeech.locales.map((locale) => languageName(locale.split('-')[0])))]
    return (
      <p className="error-text small">
        Apple’s speech-to-text doesn’t support {languageName(language)}. On this Mac it supports{' '}
        {supported.join(', ')}. Choose one of these, or use an Endpoint for this language. Downloadable Whisper models
        for more languages are coming.
      </p>
    )
  }
  return (
    downloadNotice ?? (
      <p className="muted small">
        Transcribes as {appleSpeech.locale}. The first dictation in a new language downloads Apple’s language files.
      </p>
    )
  )
}

function EndpointTest({ role }: { role: ModelRole }) {
  const [result, setResult] = useState<EndpointTestResult | 'testing' | null>(null)
  const test = () => {
    setResult('testing')
    void api.testEndpoint(role).then(setResult, (error: unknown) => setResult({ ok: false, error: String(error) }))
  }
  return (
    <>
      <SettingRow title="Test Endpoint" description="Sends a tiny request to check it answers.">
        <div className="secret">
          {result !== null && result !== 'testing' && result.ok && <span className="badge ok">Working</span>}
          <button className="button" disabled={result === 'testing'} onClick={test}>
            {result === 'testing' ? 'Testing…' : 'Test'}
          </button>
        </div>
      </SettingRow>
      {result !== null && result !== 'testing' && !result.ok && <p className="error-text small">{result.error}</p>}
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
