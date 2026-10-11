import { useState } from 'react'
import { isRunnable, MODEL_TASKS, type ModelLibrary, type ModelStatus, type ModelTask, type SpeedTier } from '../../../shared/modelLibrary'
import { MODEL_ROLES, type ModelRole, type PublicSettings } from '../../../shared/types'
import { formatBytes } from '../format'

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

const ROLE_LABELS: Record<ModelRole, string> = { speechToText: 'speech-to-text', chat: 'chat' }

/** The role a downloaded model is selected for, if any; it can't be removed while selected. */
function selectedRole(settings: PublicSettings, id: string): ModelRole | null {
  return (
    MODEL_ROLES.find((role) => {
      const selection = settings[role]
      return selection.kind === 'builtIn' && selection.modelId === id
    }) ?? null
  )
}

/** Recommended models and the ones the user added, grouped by task, with downloads. */
export function ModelsSection({ library, settings }: { library: ModelLibrary; settings: PublicSettings }) {
  const [notice, setNotice] = useState<string | null>(null)

  const remove = (status: ModelStatus) =>
    void api.removeModel(status.model.id).then(
      (bytes) => setNotice(`Removed ${status.model.name}, freeing ${formatBytes(bytes)}.`),
      (error: unknown) => setNotice(`Couldn’t remove ${status.model.name}: ${error instanceof Error ? error.message : String(error)}`),
    )

  return (
    <section className="card settings-section">
      <h2>Built-in models</h2>
      <p className="muted small">
        Recommended models run on this Mac and are downloaded from Hugging Face. Downloaded speech-to-text models can
        be selected once installed; chat and vision models become selectable once their engine ships.
      </p>
      {MODEL_TASKS.map((task) => (
        <div key={task} className="model-group">
          <h3 className="section-title">{TASK_TITLES[task]}</h3>
          {library.models
            .filter((status) => status.model.task === task)
            .map((status) => (
              <ModelRow
                key={status.model.id}
                status={status}
                selectedFor={selectedRole(settings, status.model.id)}
                onRemove={() => remove(status)}
              />
            ))}
        </div>
      ))}
      <p className="muted small">
        Downloaded models use {formatBytes(library.diskUsageBytes)} on disk.
        {notice && ` ${notice}`}
      </p>
    </section>
  )
}

function ModelRow(props: { status: ModelStatus; selectedFor: ModelRole | null; onRemove: () => void }) {
  const { status, selectedFor } = props
  const { model, oversized, userAdded } = status
  return (
    <div className="setting-row">
      <div>
        <div className="setting-title">
          {model.name}
          {selectedFor && <span className="badge ok">In use for {ROLE_LABELS[selectedFor]}</span>}
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
        <DownloadActions {...props} />
      </div>
    </div>
  )
}

function DownloadDetails({ status }: { status: ModelStatus }) {
  const { state } = status
  switch (state.kind) {
    case 'notDownloaded':
      return null
    case 'installed':
      return status.preparing ? (
        <p className="muted small">Preparing for this Mac… The first load compiles it and can take a couple of minutes.</p>
      ) : null
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

function DownloadActions({ status, selectedFor, onRemove }: { status: ModelStatus; selectedFor: ModelRole | null; onRemove: () => void }) {
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
          {selectedFor === null && model.task === 'speechToText' && isRunnable(model) && (
            <button className="button" onClick={() => void api.updateSettings({ speechToText: { kind: 'builtIn', modelId: model.id } })}>
              Use for speech-to-text
            </button>
          )}
          {selectedFor === null ? (
            <button className="link danger" onClick={onRemove}>
              Remove
            </button>
          ) : (
            <button className="link" disabled title={`Choose another ${ROLE_LABELS[selectedFor]} model to remove it`}>
              Remove
            </button>
          )}
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
