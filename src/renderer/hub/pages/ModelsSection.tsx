import { useState } from 'react'
import {
  isRunnable,
  MODEL_TASKS,
  type ModelLibrary,
  type ModelStatus,
  type ModelTask,
  type RepoCheck,
  type SpeedTier,
} from '../../../shared/modelLibrary'
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
        Recommended models, and any you add, run on this Mac and are downloaded from Hugging Face. Downloaded speech-to-text and chat
        models can be selected once installed; vision models become selectable once Lens ships.
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
      <AddFromHub />
      <p className="muted small">
        Downloaded models use {formatBytes(library.diskUsageBytes)} on disk.
        {notice && ` ${notice}`}
      </p>
    </section>
  )
}

/** Checks a pasted repo id or URL before anything is downloaded, then downloads it as a user-added model. */
function AddFromHub() {
  const [input, setInput] = useState('')
  const [checked, setChecked] = useState<{ input: string; check: RepoCheck } | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const failed = (error: unknown): RepoCheck => ({
    kind: 'rejected',
    reason: 'hubFailed',
    message: error instanceof Error ? error.message : String(error),
  })
  const check = (value: string) => {
    if (!value.trim()) return
    setInput(value)
    setNotice(null)
    setChecked(null)
    setBusy(true)
    void api
      .checkHubRepo(value)
      .catch(failed)
      .then((result) => setChecked({ input: value, check: result }))
      .finally(() => setBusy(false))
  }
  const add = (value: string) => {
    setBusy(true)
    void api
      .addHubModel(value)
      .catch(failed)
      .then((result) => {
        if (result.kind !== 'compatible') return setChecked({ input: value, check: result })
        setChecked(null)
        setInput('')
        setNotice(`Downloading ${result.model.name}; it’s listed under ${TASK_TITLES[result.model.task]} as added by you.`)
      })
      .finally(() => setBusy(false))
  }

  return (
    <div className="model-group">
      <h3 className="section-title">Add from Hugging Face</h3>
      <div className="setting-row">
        <div>
          <div className="muted small">
            Paste a repo id or URL. OpenWispr checks that it can run the model before downloading anything: MLX chat and
            vision models, and WhisperKit or Parakeet speech-to-text models.
          </div>
          {checked && <CheckResult check={checked.check} busy={busy} onAdd={() => add(checked.input)} onCheck={check} />}
          {notice && <p className="muted small">{notice}</p>}
        </div>
        <div className="setting-control model-actions">
          <input
            value={input}
            placeholder="mlx-community/Qwen3-4B-Instruct-2507-4bit"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && check(input)}
          />
          <button className="button" disabled={busy || !input.trim()} onClick={() => check(input)}>
            {busy && !checked ? 'Checking…' : 'Check'}
          </button>
        </div>
      </div>
    </div>
  )
}

function CheckResult(props: { check: RepoCheck; busy: boolean; onAdd: () => void; onCheck: (input: string) => void }) {
  const { check } = props
  switch (check.kind) {
    case 'compatible': {
      const { model } = check
      return (
        <div className="model-check">
          <div className="setting-title">
            {model.name}
            <span className="badge ok">Compatible</span>
            {check.oversized && <span className="badge warn">Needs more memory than this Mac can spare</span>}
          </div>
          <div className="muted small">
            {TASK_TITLES[model.task]} · {check.summary} · {formatBytes(model.sizeBytes)} download · about{' '}
            {formatBytes(model.memoryBytes)} memory · {SPEED_LABELS[model.speed]} · {model.languages}
          </div>
          {!isRunnable(model) && <p className="muted small">It can be downloaded now and selected once Lens ships.</p>}
          <button className="button" disabled={props.busy} onClick={props.onAdd}>
            Download
          </button>
        </div>
      )
    }
    case 'severalModels':
      return (
        <div className="model-check">
          <p className="small">{check.message}:</p>
          <select
            defaultValue=""
            onChange={(e) => props.onCheck(`https://huggingface.co/${check.repo}/tree/${check.revision}/${e.target.value}`)}
          >
            <option value="" disabled>
              Choose a model folder
            </option>
            {check.folders.map((folder) => (
              <option key={folder} value={folder}>
                {folder}
              </option>
            ))}
          </select>
        </div>
      )
    case 'rejected':
      return <p className="error-text small">{check.message}.</p>
    default: {
      const unreachable: never = check
      throw new Error(`unhandled repo check ${JSON.stringify(unreachable)}`)
    }
  }
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
          {selectedFor === null && isRole(model.task) && isRunnable(model) && (
            <UseButton role={model.task} modelId={model.id} />
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

function isRole(task: ModelTask): task is ModelRole {
  return (MODEL_ROLES as ModelTask[]).includes(task)
}

function UseButton({ role, modelId }: { role: ModelRole; modelId: string }) {
  return (
    <button className="button" onClick={() => void api.updateSettings({ [role]: { kind: 'builtIn', modelId } })}>
      Use for {ROLE_LABELS[role]}
    </button>
  )
}

function percent(done: number, total: number): number {
  return total > 0 ? Math.floor((done / total) * 100) : 0
}
