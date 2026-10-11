import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { Channel, type OpenWisprApi } from '../shared/api'

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T) => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: OpenWisprApi = {
  getSettings: () => ipcRenderer.invoke(Channel.getSettings),
  updateSettings: (patch) => ipcRenderer.invoke(Channel.updateSettings, patch),
  testEndpoint: (role) => ipcRenderer.invoke(Channel.testEndpoint, role),
  getModelLibrary: () => ipcRenderer.invoke(Channel.getModelLibrary),
  downloadModel: (id) => ipcRenderer.invoke(Channel.downloadModel, id),
  cancelDownload: (id) => ipcRenderer.invoke(Channel.cancelDownload, id),
  removeModel: (id) => ipcRenderer.invoke(Channel.removeModel, id),
  getHistory: () => ipcRenderer.invoke(Channel.getHistory),
  deleteHistoryEntry: (id) => ipcRenderer.invoke(Channel.deleteHistoryEntry, id),
  clearHistory: () => ipcRenderer.invoke(Channel.clearHistory),
  getStats: () => ipcRenderer.invoke(Channel.getStats),
  getDictionary: () => ipcRenderer.invoke(Channel.getDictionary),
  saveDictionary: (entries) => ipcRenderer.invoke(Channel.saveDictionary, entries),
  getSnippets: () => ipcRenderer.invoke(Channel.getSnippets),
  saveSnippets: (snippets) => ipcRenderer.invoke(Channel.saveSnippets, snippets),
  getPermissions: () => ipcRenderer.invoke(Channel.getPermissions),
  requestAccessibility: () => ipcRenderer.invoke(Channel.requestAccessibility),
  requestMicrophone: () => ipcRenderer.invoke(Channel.requestMicrophone),
  copyText: (text) => ipcRenderer.invoke(Channel.copyText, text),
  startShortcutCapture: () => ipcRenderer.invoke(Channel.startShortcutCapture),
  stopShortcutCapture: () => ipcRenderer.invoke(Channel.stopShortcutCapture),
  onShortcutCapture: (listener) => subscribe(Channel.shortcutCapture, listener),
  onDataChanged: (listener) => subscribe(Channel.dataChanged, listener),

  getMeetings: () => ipcRenderer.invoke(Channel.getMeetings),
  getMeeting: (id) => ipcRenderer.invoke(Channel.getMeeting, id),
  createMeeting: () => ipcRenderer.invoke(Channel.createMeeting),
  updateMeeting: (id, patch) => ipcRenderer.invoke(Channel.updateMeeting, id, patch),
  deleteMeeting: (id) => ipcRenderer.invoke(Channel.deleteMeeting, id),
  generateMeetingSummary: (id) => ipcRenderer.invoke(Channel.generateMeetingSummary, id),
  getNotetakerState: () => ipcRenderer.invoke(Channel.getNotetakerState),
  startMeetingRecording: (id) => ipcRenderer.invoke(Channel.startMeetingRecording, id),
  stopMeetingRecording: () => ipcRenderer.invoke(Channel.stopMeetingRecording),

  onFlowBarState: (listener) => subscribe(Channel.flowBarState, listener),
  onRecorderCommand: (listener) => subscribe(Channel.recorderCommand, listener),
  onSound: (listener) => subscribe(Channel.sound, listener),
  sendRecorderEvent: (event) => ipcRenderer.send(Channel.recorderEvent, event),
  submitAudio: (wav) => ipcRenderer.send(Channel.submitAudio, wav),
  setFlowBarInteractive: (interactive) => ipcRenderer.send(Channel.setFlowBarInteractive, interactive),
  flowBarAction: (action) => ipcRenderer.send(Channel.flowBarAction, action),

  onMeetingRecorderCommand: (listener) => subscribe(Channel.meetingRecorderCommand, listener),
  sendMeetingRecorderEvent: (event) => ipcRenderer.send(Channel.meetingRecorderEvent, event),
  submitMeetingChunk: (chunk) => ipcRenderer.send(Channel.submitMeetingChunk, chunk),
}

contextBridge.exposeInMainWorld('openwispr', api)
