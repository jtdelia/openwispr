import {
  APPLE_SELECTION,
  DEFAULT_SHORTCUTS,
  type EndpointConfig,
  type ModelSelection,
  type ModelSelectionPatch,
  type Settings,
  type SettingsPatch,
} from '../shared/types'

export const DEFAULT_SETTINGS: Settings = {
  speechToText: { ...APPLE_SELECTION },
  chat: { ...APPLE_SELECTION },
  language: '',
  cleanup: { enabled: true },
  shortcuts: DEFAULT_SHORTCUTS,
  styles: { personal: 'casual', work: 'casual', email: 'formal', other: 'casual' },
  microphoneId: '',
  sounds: true,
  restoreClipboard: true,
  showFlowBar: true,
  launchAtLogin: false,
  userName: '',
}

/** Before Models, each role was an Endpoint config, with Cleanup's living under `cleanup`. */
interface LegacySettings {
  transcription?: Partial<EndpointConfig & { language: string }>
  cleanup?: Partial<EndpointConfig & { enabled: boolean }>
}

/** What older versions used when a field was missing. */
const LEGACY_BASE_URL = 'https://api.openai.com/v1'
const LEGACY_MODELS = { speechToText: 'gpt-4o-mini-transcribe', chat: 'gpt-4.1-mini' }

function legacyEndpoint(config: Partial<EndpointConfig>, role: keyof typeof LEGACY_MODELS): EndpointConfig {
  return { baseUrl: config.baseUrl ?? LEGACY_BASE_URL, model: config.model ?? LEGACY_MODELS[role], apiKey: config.apiKey ?? '' }
}

/**
 * Settings as read from disk, migrating older files; API keys stay as stored (encrypted). An older
 * role stays on its Endpoint when the user changed its base URL or stored a key; otherwise it moves
 * to Apple's model. Chat without a key of its own gets a copy of the transcription key for the same
 * server, which older versions lent it.
 */
export function loadSettings(stored: Record<string, unknown>): Settings {
  const { transcription, cleanup, ...rest } = stored as SettingsPatch & LegacySettings
  const patch: SettingsPatch = rest
  const isCustom = (config: EndpointConfig) => config.baseUrl !== LEGACY_BASE_URL || config.apiKey !== ''
  let speechToText: EndpointConfig | undefined
  if (transcription) {
    speechToText = legacyEndpoint(transcription, 'speechToText')
    if (isCustom(speechToText)) patch.speechToText ??= { kind: 'endpoint', ...speechToText }
    patch.language ??= transcription.language
  }
  if (cleanup) {
    const chat = legacyEndpoint(cleanup, 'chat')
    const sharedKey = speechToText?.baseUrl === chat.baseUrl ? speechToText.apiKey : ''
    if (chat.apiKey === '') chat.apiKey = sharedKey
    if (isCustom(chat)) patch.chat ??= { kind: 'endpoint', ...chat }
    patch.cleanup = cleanup.enabled === undefined ? {} : { enabled: cleanup.enabled }
  }
  return applySettingsPatch(DEFAULT_SETTINGS, patch)
}

function applySelectionPatch(current: ModelSelection, patch: ModelSelectionPatch): ModelSelection {
  switch (patch.kind) {
    case 'builtIn':
      return { kind: 'builtIn', modelId: patch.modelId }
    case 'endpoint': {
      const base = current.kind === 'endpoint' ? current : { baseUrl: '', model: '', apiKey: '' }
      return {
        kind: 'endpoint',
        baseUrl: patch.baseUrl ?? base.baseUrl,
        model: patch.model ?? base.model,
        apiKey: patch.apiKey ?? base.apiKey,
      }
    }
    default: {
      const unreachable: never = patch
      throw new Error(`unhandled model selection ${JSON.stringify(unreachable)}`)
    }
  }
}

export function applySettingsPatch(base: Settings, patch: SettingsPatch): Settings {
  const merged = { ...base } as Record<string, unknown>
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (key === 'speechToText' || key === 'chat') {
      merged[key] = applySelectionPatch(base[key], value as ModelSelectionPatch)
      continue
    }
    const current = merged[key]
    merged[key] =
      value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object'
        ? { ...current, ...value }
        : value
  }
  return merged as unknown as Settings
}
