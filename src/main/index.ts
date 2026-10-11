import { join } from 'node:path'
import { app, clipboard, ipcMain, Menu, systemPreferences, Tray } from 'electron'
import { Channel, type FlowBarAction, type MeetingChunk, type MeetingRecorderEvent, type RecorderEvent } from '../shared/api'
import { microphoneHelp } from '../shared/permissions'
import {
  MODEL_ROLES,
  type DictionaryEntry,
  type MeetingPatch,
  type ModelRole,
  type NotetakerState,
  type PermissionStatus,
  type SettingsPatch,
  type Snippet,
} from '../shared/types'
import { DictationController } from './dictation'
import { Helper } from './helper'
import { MeetingStore } from './meetingStore'
import { spawnTransport } from './modelProcess'
import { Models } from './models'
import { MODEL_PROCESS, nativeExecutablePath } from './nativeExecutables'
import { NotetakerController } from './notetaker'
import { ShortcutEngine } from './shortcutEngine'
import { Store } from './store'
import { enableSystemAudioFeatures, installSystemAudioHandler } from './systemAudio'
import { trayIcon } from './trayIcon'
import { Windows } from './windows'

if (!app.requestSingleInstanceLock()) app.quit()
enableSystemAudioFeatures()

let tray: Tray | null = null

async function main(): Promise<void> {
  await app.whenReady()
  installSystemAudioHandler()

  const store = new Store()
  const meetings = new MeetingStore()
  const modelProcessPath = nativeExecutablePath(MODEL_PROCESS, {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  })
  const modelsDir = join(app.getPath('userData'), 'models')
  const models = new Models({
    fetch: globalThis.fetch,
    settings: () => store.settings,
    transport: spawnTransport(modelProcessPath, { requestSpeechAuthorization: app.isPackaged, modelsDir }),
    modelsDir,
  })
  const helper = new Helper()
  const windows = new Windows()
  models.on('progress', (progress) => windows.broadcast(Channel.modelProgress, progress))
  const engine = new ShortcutEngine(store.settings.shortcuts)
  const dictation = new DictationController(helper, store, models, windows, engine)
  const notetaker = new NotetakerController(helper, store, models, meetings, windows, (state) => updateTray(state))
  let capturingShortcut = false
  let captureHeld = new Set<number>()
  let accessibility = { trusted: false, keyTapRunning: false }

  windows.setFlowBarEnabled(store.settings.showFlowBar)

  helper.on('ready', (status) => {
    accessibility = status
    dictation.syncHelperShortcuts()
    windows.broadcast(Channel.dataChanged, 'permissions')
  })
  helper.on('key', (keycode, down) => {
    if (capturingShortcut) {
      if (down) captureHeld.add(keycode)
      else captureHeld.delete(keycode)
      windows.hubWindow?.webContents.send(Channel.shortcutCapture, [...captureHeld])
      return
    }
    for (const gesture of engine.handleKey(keycode, down)) dictation.handleGesture(gesture)
  })
  helper.on('tapReset', () => engine.clearHeld())
  helper.on('speakers', (report) => notetaker.handleSpeakers(report))
  helper.start()

  async function permissions(promptAccessibility = false): Promise<PermissionStatus> {
    if (helper.running) {
      accessibility = await helper
        .request<{ trusted: boolean; keyTapRunning: boolean }>('getAccessibilityStatus', { prompt: promptAccessibility })
        .catch(() => accessibility)
    }
    return {
      helperRunning: helper.running,
      accessibility: accessibility.trusted,
      keyTapRunning: accessibility.keyTapRunning,
      microphone: systemPreferences.getMediaAccessStatus('microphone'),
    }
  }

  // Accessibility can be granted at any time in System Settings; pick it up without a restart.
  setInterval(() => {
    if (accessibility.keyTapRunning) return
    void permissions().then((status) => {
      if (status.keyTapRunning) windows.broadcast(Channel.dataChanged, 'permissions')
    })
  }, 2000)

  ipcMain.handle(Channel.getSettings, () => store.publicSettings)
  ipcMain.handle(Channel.updateSettings, (_e, patch: SettingsPatch) => {
    store.updateSettings(patch)
    const settings = store.settings
    engine.setShortcuts(settings.shortcuts)
    dictation.syncHelperShortcuts()
    windows.setFlowBarEnabled(settings.showFlowBar)
    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin })
    windows.broadcast(Channel.dataChanged, 'settings')
    return store.publicSettings
  })
  ipcMain.handle(Channel.testEndpoint, (_e, role: ModelRole) => {
    if (!MODEL_ROLES.includes(role)) throw new Error(`Unknown model role ${String(role)}`)
    return models.testEndpoint(role)
  })
  ipcMain.handle(Channel.getBuiltInStatus, () => models.status())
  models.onLibraryChanged(() => windows.broadcast(Channel.dataChanged, 'models'))
  ipcMain.handle(Channel.getModelLibrary, () => models.library())
  ipcMain.handle(Channel.downloadModel, (_e, id: string) => {
    // A failure is shown from the library state, which keeps the error.
    void models.download(id).catch(() => undefined)
  })
  ipcMain.handle(Channel.cancelDownload, (_e, id: string) => models.cancelDownload(id))
  ipcMain.handle(Channel.removeModel, (_e, id: string) => models.removeModel(id))
  ipcMain.handle(Channel.checkHubRepo, (_e, input: string) => models.checkRepo(String(input)))
  ipcMain.handle(Channel.addHubModel, async (_e, input: string) => {
    const check = await models.checkRepo(String(input))
    // As for Recommended models, a failure is shown from the library state.
    if (check.kind === 'compatible') void models.addModel(check.model).catch(() => undefined)
    return check
  })
  ipcMain.handle(Channel.getHistory, () => store.getHistory())
  ipcMain.handle(Channel.deleteHistoryEntry, (_e, id: string) => {
    store.deleteHistory(id)
    windows.broadcast(Channel.dataChanged, 'history')
  })
  ipcMain.handle(Channel.clearHistory, () => {
    store.clearHistory()
    windows.broadcast(Channel.dataChanged, 'history')
  })
  ipcMain.handle(Channel.getStats, () => store.stats())
  ipcMain.handle(Channel.getDictionary, () => store.dictionary)
  ipcMain.handle(Channel.saveDictionary, (_e, entries: DictionaryEntry[]) => {
    store.setDictionary(entries)
    windows.broadcast(Channel.dataChanged, 'dictionary')
  })
  ipcMain.handle(Channel.getSnippets, () => store.snippets)
  ipcMain.handle(Channel.saveSnippets, (_e, snippets: Snippet[]) => {
    store.setSnippets(snippets)
    windows.broadcast(Channel.dataChanged, 'snippets')
  })
  ipcMain.handle(Channel.getPermissions, () => permissions())
  ipcMain.handle(Channel.requestAccessibility, () => permissions(true))
  ipcMain.handle(Channel.requestMicrophone, async () => {
    await systemPreferences.askForMediaAccess('microphone')
    windows.broadcast(Channel.dataChanged, 'permissions')
    return permissions()
  })
  ipcMain.handle(Channel.copyText, (_e, text: string) => clipboard.writeText(text))
  ipcMain.handle(Channel.startShortcutCapture, () => {
    capturingShortcut = true
    captureHeld = new Set()
    engine.clearHeld()
    void helper.request('setShortcuts', { combos: [] }).catch(() => undefined)
  })
  ipcMain.handle(Channel.stopShortcutCapture, () => {
    capturingShortcut = false
    engine.clearHeld()
    dictation.syncHelperShortcuts()
  })

  ipcMain.handle(Channel.getMeetings, () => meetings.list())
  ipcMain.handle(Channel.getMeeting, (_e, id: string) => meetings.detail(id))
  ipcMain.handle(Channel.createMeeting, () => {
    const meeting = meetings.create()
    windows.broadcast(Channel.dataChanged, 'meetings')
    return meeting
  })
  ipcMain.handle(Channel.updateMeeting, (_e, id: string, patch: MeetingPatch) => {
    const { title, notes, speakerNames } = patch
    meetings.update(id, {
      ...(typeof title === 'string' ? { title } : {}),
      ...(typeof notes === 'string' ? { notes } : {}),
    })
    if (speakerNames && typeof speakerNames === 'object') {
      const names = Object.entries(speakerNames)
        .filter((pair): pair is [string, string] => typeof pair[1] === 'string' && pair[1].trim() !== '')
        .map(([key, name]) => [key, name.trim()])
      notetaker.setSpeakerNames(id, Object.fromEntries(names))
    }
    windows.broadcast(Channel.dataChanged, 'meetings')
  })
  ipcMain.handle(Channel.deleteMeeting, (_e, id: string) => {
    notetaker.discard(id)
    meetings.delete(id)
    windows.broadcast(Channel.dataChanged, 'meetings')
  })
  ipcMain.handle(Channel.generateMeetingSummary, (_e, id: string) => notetaker.generateSummary(id))
  ipcMain.handle(Channel.getNotetakerState, () => notetaker.current)
  ipcMain.handle(Channel.startMeetingRecording, async (_e, id: string) => {
    // Without access macOS hands the recorder a silent stream instead of failing.
    if (systemPreferences.getMediaAccessStatus('microphone') === 'not-determined') {
      await systemPreferences.askForMediaAccess('microphone')
      windows.broadcast(Channel.dataChanged, 'permissions')
    }
    const help = microphoneHelp(systemPreferences.getMediaAccessStatus('microphone'))
    if (help) throw new Error(`OpenWispr can't use the microphone. ${help}`)
    notetaker.start(id)
  })
  ipcMain.handle(Channel.stopMeetingRecording, () => void notetaker.stop())
  ipcMain.on(Channel.meetingRecorderEvent, (_e, event: MeetingRecorderEvent) => notetaker.handleRecorderEvent(event))
  ipcMain.on(Channel.submitMeetingChunk, (_e, chunk: MeetingChunk) => notetaker.handleChunk(chunk))

  ipcMain.on(Channel.recorderEvent, (_e, event: RecorderEvent) => dictation.handleRecorderEvent(event))
  ipcMain.on(Channel.submitAudio, (_e, wav: ArrayBuffer) => void dictation.handleAudio(Buffer.from(wav)))
  ipcMain.on(Channel.setFlowBarInteractive, (_e, interactive: boolean) => windows.setFlowBarInteractive(interactive))
  ipcMain.on(Channel.flowBarAction, (_e, action: FlowBarAction) => {
    switch (action) {
      case 'startHandsFree':
        dictation.start('handsFree')
        return
      case 'stop':
        dictation.stop()
        return
      case 'cancel':
        dictation.cancel()
        return
      case 'openHub':
        windows.showHub()
        return
      default: {
        const unreachable: never = action
        throw new Error(`unhandled flow bar action ${String(unreachable)}`)
      }
    }
  })

  tray = new Tray(trayIcon())
  tray.setToolTip('OpenWispr')
  function updateTray(state: NotetakerState): void {
    if (!tray) return
    const recording = state.kind === 'recording'
    // Recording other people should never be invisible.
    tray.setTitle(recording ? ' ● Notes' : '')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open OpenWispr', click: () => windows.showHub() },
        { label: 'Start hands-free dictation', click: () => dictation.start('handsFree') },
        ...(recording ? [{ label: 'Stop taking meeting notes', click: () => void notetaker.stop() }] : []),
        { type: 'separator' },
        { label: 'Quit OpenWispr', role: 'quit' },
      ]),
    )
  }
  updateTray(notetaker.current)

  app.on('second-instance', () => windows.showHub())
  app.on('activate', () => windows.showHub())
  app.on('window-all-closed', () => {
    // Stay alive in the menu bar; the flow bar window is never closed.
  })
  app.on('before-quit', () => {
    store.flush()
    meetings.flush()
    helper.stop()
    models.stop()
    // A non-closable window would otherwise veto app.quit().
    windows.flowBar.destroy()
  })

  const status = await permissions()
  await models.ready
  const needsSetup = !models.availability('speechToText').available || !status.accessibility || status.microphone !== 'granted'
  if (needsSetup || !app.getLoginItemSettings().wasOpenedAtLogin) windows.showHub()
}

void main()
