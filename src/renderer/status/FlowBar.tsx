import { useEffect, useRef, useState } from 'react'
import { comboLabel } from '../../shared/keycodes'
import type { FlowBarState, ModelProgress } from '../../shared/types'
import { MeetingRecorder } from './meetingRecorder'
import { Recorder } from './recorder'
import { playSound } from './sounds'

const BAR_COUNT = 13
const api = window.openwispr

export function FlowBar() {
  const [state, setState] = useState<FlowBarState>({ kind: 'resting' })
  const [levels, setLevels] = useState<number[]>(() => Array(BAR_COUNT).fill(0))
  const [hovered, setHovered] = useState(false)
  const [pttLabel, setPttLabel] = useState('fn')
  const [download, setDownload] = useState<ModelProgress | null>(null)
  const latestLevel = useRef(0)
  const recorder = useRef<Recorder>(null)
  const meetingRecorder = useRef<MeetingRecorder>(null)

  recorder.current ??= new Recorder((level) => (latestLevel.current = level))
  meetingRecorder.current ??= new MeetingRecorder((chunk) => api.submitMeetingChunk(chunk))

  useEffect(() => {
    const loadShortcut = () => void api.getSettings().then((s) => setPttLabel(comboLabel(s.shortcuts.ptt)))
    loadShortcut()
    const unsubscribers = [
      api.onFlowBarState(setState),
      api.onSound(playSound),
      api.onDataChanged((topic) => topic === 'settings' && loadShortcut()),
      api.onModelProgress((progress) => setDownload(progress.fraction < 1 ? progress : null)),
      api.onRecorderCommand((command) => {
        const rec = recorder.current!
        switch (command.type) {
          case 'start':
            rec.start(command.deviceId).then(
              () => api.sendRecorderEvent({ type: 'started' }),
              (error: unknown) =>
                api.sendRecorderEvent({ type: 'error', message: error instanceof Error ? error.message : String(error) }),
            )
            return
          case 'stop':
            void rec.stop().then((wav) => api.submitAudio(wav))
            return
          case 'cancel':
            rec.cancel()
            return
          default: {
            const unreachable: never = command
            throw new Error(`unhandled recorder command ${JSON.stringify(unreachable)}`)
          }
        }
      }),
      api.onMeetingRecorderCommand((command) => {
        const rec = meetingRecorder.current!
        switch (command.type) {
          case 'start':
            rec.start(command.session, command.deviceId).then(
              ({ systemAudioError }) =>
                api.sendMeetingRecorderEvent({ type: 'started', session: command.session, systemAudioError }),
              (error: unknown) =>
                api.sendMeetingRecorderEvent({
                  type: 'error',
                  session: command.session,
                  message: error instanceof Error ? error.message : String(error),
                }),
            )
            return
          case 'stop':
            void rec.stop().then(() => api.sendMeetingRecorderEvent({ type: 'stopped', session: command.session }))
            return
          case 'cut':
            rec.cut(command.session, command.source)
            return
          default: {
            const unreachable: never = command
            throw new Error(`unhandled meeting recorder command ${JSON.stringify(unreachable)}`)
          }
        }
      }),
    ]
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }, [])

  const listening = state.kind === 'listening' || state.kind === 'initializing'
  useEffect(() => {
    if (!listening) {
      setLevels(Array(BAR_COUNT).fill(0))
      return
    }
    const timer = setInterval(() => {
      setLevels((previous) => [...previous.slice(1), latestLevel.current])
    }, 45)
    return () => clearInterval(timer)
  }, [listening])

  const setInteractive = (interactive: boolean) => {
    setHovered(interactive)
    api.setFlowBarInteractive(interactive)
  }

  return (
    <div className="stage">
      {download && (
        <div className="tooltip">
          Downloading Apple’s speech-to-text for {download.locale}… {Math.round(download.fraction * 100)}%
        </div>
      )}
      {!download && state.kind === 'resting' && hovered && (
        <div className="tooltip">
          Click or hold <kbd>{pttLabel}</kbd> to start dictating
        </div>
      )}
      <div
        className={`pill pill-${state.kind}${hovered ? ' hovered' : ''}${state.kind === 'notice' ? ` tone-${state.tone}` : ''}`}
        onMouseEnter={() => setInteractive(true)}
        onMouseLeave={() => setInteractive(false)}
        onClick={() => state.kind === 'resting' && api.flowBarAction('startHandsFree')}
      >
        {state.kind === 'resting' && hovered && <Bars levels={Array(BAR_COUNT).fill(0)} idle />}
        {(state.kind === 'initializing' || state.kind === 'listening') && (
          <>
            {state.mode === 'handsFree' && (
              <button className="icon-button cancel" title="Cancel (Esc)" onClick={() => api.flowBarAction('cancel')}>
                ✕
              </button>
            )}
            <Bars levels={levels} idle={state.kind === 'initializing'} />
            {state.mode === 'handsFree' && (
              <button className="icon-button stop" title="Finish" onClick={() => api.flowBarAction('stop')}>
                <span />
              </button>
            )}
          </>
        )}
        {state.kind === 'processing' && (
          <div className="dots">
            <span />
            <span />
            <span />
          </div>
        )}
        {state.kind === 'notice' && <span className="notice">{state.message}</span>}
      </div>
    </div>
  )
}

function Bars({ levels, idle }: { levels: number[]; idle: boolean }) {
  return (
    <div className={`bars${idle ? ' idle' : ''}`}>
      {levels.map((level, i) => (
        <span key={i} style={{ height: `${Math.max(3, Math.round(level * 18))}px` }} />
      ))}
    </div>
  )
}
