import {
  DEFAULT_SHORTCUTS,
  type EndpointConfig,
  type ModelSelection,
  type ModelSelectionPatch,
  type Settings,
  type SettingsPatch,
} from '../shared/types'

export const DEFAULT_SETTINGS: Settings = {
  speechToText: { kind: 'endpoint', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini-transcribe', apiKey: '' },
  chat: { kind: 'endpoint', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', apiKey: '' },
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

/** Before Models, each role was a provider config, with Cleanup's living under `cleanup`. */
interface LegacySettings {
  transcription?: Partial<EndpointConfig & { language: string }>
  cleanup?: Partial<EndpointConfig & { enabled: boolean }>
}

function legacyEndpoint(config: Partial<EndpointConfig>): ModelSelectionPatch {
  return { kind: 'endpoint', baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey }
}

/** Settings as read from disk, migrating older files; API keys stay as stored (encrypted). */
export function loadSettings(stored: Record<string, unknown>): Settings {
  const { transcription, cleanup, ...rest } = stored as SettingsPatch & LegacySettings
  const patch: SettingsPatch = rest
  if (transcription) {
    patch.speechToText ??= legacyEndpoint(transcription)
    patch.language ??= transcription.language
  }
  if (cleanup) {
    if ('baseUrl' in cleanup || 'model' in cleanup) patch.chat ??= legacyEndpoint(cleanup)
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
