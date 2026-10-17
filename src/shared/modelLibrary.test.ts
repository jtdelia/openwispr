import { describe, expect, it } from 'vitest'
import { offeredModel, type DownloadState, type ModelEntry, type ModelStatus } from './modelLibrary'

function status(id: string, model: Partial<ModelEntry>, extra: { state?: DownloadState; oversized?: boolean; recommended?: boolean } = {}): ModelStatus {
  return {
    model: {
      id,
      name: id,
      task: 'chat',
      engine: 'mlx',
      sources: [],
      sizeBytes: 1,
      memoryBytes: 1,
      speed: 'fast',
      languages: '',
      languageCodes: null,
      ...model,
    },
    recommended: extra.recommended ?? true,
    userAdded: !(extra.recommended ?? true),
    oversized: extra.oversized ?? false,
    state: extra.state ?? { kind: 'notDownloaded' },
    preparing: false,
  }
}

const installed: DownloadState = { kind: 'installed', sizeBytes: 1 }

describe('offeredModel', () => {
  it('offers the first Recommended chat model this Mac has the memory for', () => {
    const models = [
      status('whisper', { task: 'speechToText', engine: 'whisperKit' }),
      status('huge', {}, { oversized: true }),
      status('small', {}),
      status('medium', {}),
    ]
    expect(offeredModel(models, 'chat')?.model.id).toBe('small')
  })

  it('prefers a chat model that is already installed, including one the user added', () => {
    const models = [status('small', {}), status('mine', {}, { recommended: false, state: installed })]
    expect(offeredModel(models, 'chat')?.model.id).toBe('mine')
  })

  it("skips models the model process can't run and offers nothing when none fit", () => {
    const models = [
      status('vision', { task: 'vision' }, { state: installed }),
      status('huge', {}, { oversized: true }),
      status('mine', {}, { recommended: false }),
    ]
    expect(offeredModel(models, 'chat')).toBeNull()
  })

  it('narrows the offer to an engine, like Whisper for languages Apple lacks', () => {
    const models = [
      status('parakeet', { task: 'speechToText', engine: 'fluidAudio' }, { state: installed }),
      status('whisper', { task: 'speechToText', engine: 'whisperKit' }),
    ]
    expect(offeredModel(models, 'speechToText', 'whisperKit')?.model.id).toBe('whisper')
  })
})
