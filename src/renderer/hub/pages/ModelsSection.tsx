import { useState } from 'react'
import { MODEL_TASKS, type ModelStatus, type ModelTask, type SpeedTier } from '../../../shared/modelLibrary'
import { useData } from '../useData'

const api = window.openwispr

const TASK_TITLES: Record<ModelTask, string> = {
  speechToText: 'Speech-to-text',
  chat: 'Chat',
  vision: 'Vision (for Lens later)',
}

const SPEED_LABELS: Record<SpeedTier, string> = {
  fastest: 'Fastest',
  fast: 'Fast',
  medium: 'Medium speed',
  slow: 'Slow',
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes < 1e10 ? 2 : 1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return `${Math.max(0, Math.round(bytes / 1e3))} KB`
}

/** Recommended models and the ones the user added, grouped by task, with downloads. */
export function ModelsSection() {
  const [library] = useData(api.getModelLibrary, ['models'])
  const [freed, setFreed] = useState<string | null>(null)
  if (!library) return null

  const remove = (status: ModelStatus) =>
    void api.removeModel(status.model.id).then((bytes) => setFreed(`Removed ${status.model.name}, freeing ${formatBytes(bytes)}.`))

  return (
    <section className="card settings-section">
      <h2>Built-in models</h2>
      <p className="muted small">
        Recommended models run on this Mac and are downloaded from Hugging Face. Downloaded models become selectable once
        their engine ships.
      </p>
      {MODEL_TASKS.map((task) => (
        <div key={task} className="model-group">
          <h3 className="section-title">{TASK_TITLES[task]}</h3>
          {library.models
            .filter((status) => status.model.task === task)
            .map((status) => (
              <ModelRow key={status.model.id} status={status} onRemove={() => remove(status)} />
            ))}
        </div>
      ))}
      <p className="muted small">
        Downloaded models use {formatBytes(library.diskUsageBytes)} on disk.
        {freed && ` ${freed}`}
      </p>
    </section>
  )
}

function ModelRow({ status, onRemove }: { status: ModelStatus; onRemove: () => void }) {
  const { model, oversized, userAdded } = status
  return (
    <div className="setting-row">
      <div>
        <div className="setting-title">
          {model.name}
          {userAdded && <span className="badge">Added by you</span>}
          {oversized && <span className="badge warn">Needs more memory than this Mac can spare</span>}
        </div>
        <div className="muted small">
          {formatBytes(model.sizeBytes)} download · {formatBytes(model.memoryBytes)} memory · {SPEED_LABELS[model.speed]} ·{' '}
          {model.languages}
        </div>
        <DownloadDetails status={status} />
      </div>
      <div className="setting-control model-actions">
        <DownloadActions status={status} onRemove={onRemove} />
      </div>
    </div>
  )
}

function DownloadDetails({ status }: { status: ModelStatus }) {
  const { state } = status
  switch (state.kind) {
    case 'notDownloaded':
    case 'installed':
      return null
    case 'downloading': {
      const left = state.totalBytes - state.bytesDone
      const speed = state.bytesPerSecond > 0 ? ` · ${formatBytes(state.bytesPerSecond)}/s` : ''
      return (
        <div className="model-progress">
          <progress value={state.bytesDone} max={state.totalBytes} />
          <span className="muted small">
            {percent(state.bytesDone, state.totalBytes)}%{speed} · {formatBytes(left)} left
          </span>
        </div>
      )
    }
    case 'paused':
      return (
        <>
          <div className="model-progress">
            <progress value={state.bytesDone} max={state.totalBytes} />
            <span className="muted small">Paused at {percent(state.bytesDone, state.totalBytes)}%</span>
          </div>
          {state.error && <p className="error-text small">{state.error}</p>}
        </>
      )
    default: {
      const unreachable: never = state
      throw new Error(`unhandled download state ${JSON.stringify(unreachable)}`)
    }
  }
}

function DownloadActions({ status, onRemove }: { status: ModelStatus; onRemove: () => void }) {
  const { state, model } = status
  switch (state.kind) {
    case 'notDownloaded':
      return (
        <button className="button" onClick={() => void api.downloadModel(model.id)}>
          Download
        </button>
      )
    case 'downloading':
      return (
        <button className="link danger" onClick={() => void api.cancelDownload(model.id)}>
          Cancel
        </button>
      )
    case 'paused':
      return (
        <>
          <button className="link danger" onClick={() => void api.cancelDownload(model.id)}>
            Discard
          </button>
          <button className="button" onClick={() => void api.downloadModel(model.id)}>
            Resume
          </button>
        </>
      )
    case 'installed':
      return (
        <>
          <span className="badge ok">Installed · {formatBytes(state.sizeBytes)}</span>
          <button className="link danger" onClick={onRemove}>
            Remove
          </button>
        </>
      )
    default: {
      const unreachable: never = state
      throw new Error(`unhandled download state ${JSON.stringify(unreachable)}`)
    }
  }
}

function percent(done: number, total: number): number {
  return total > 0 ? Math.floor((done / total) * 100) : 0
}
