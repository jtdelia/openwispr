import { join } from 'node:path'
import { BrowserWindow, screen, shell } from 'electron'
import { Channel } from '../shared/api'
import type { FlowBarState } from '../shared/types'

const FLOW_BAR_WIDTH = 360
const FLOW_BAR_HEIGHT = 96
const FLOW_BAR_BOTTOM_MARGIN = 6

const preload = join(__dirname, '../preload/index.js')

function loadPage(window: BrowserWindow, page: 'hub' | 'status'): void {
  const devServer = process.env.ELECTRON_RENDERER_URL
  if (devServer) void window.loadURL(`${devServer}/${page}/index.html`)
  else void window.loadFile(join(__dirname, `../renderer/${page}/index.html`))
}

export class Windows {
  private hub: BrowserWindow | null = null
  readonly flowBar: BrowserWindow
  private flowBarState: FlowBarState = { kind: 'resting' }
  private flowBarEnabled = true

  constructor() {
    this.flowBar = new BrowserWindow({
      width: FLOW_BAR_WIDTH,
      height: FLOW_BAR_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      closable: false,
      skipTaskbar: true,
      focusable: false,
      type: 'panel',
      hiddenInMissionControl: true,
      webPreferences: { preload, backgroundThrottling: false },
    })
    this.flowBar.setAlwaysOnTop(true, 'screen-saver')
    this.flowBar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    this.flowBar.setIgnoreMouseEvents(true, { forward: true })
    this.flowBar.webContents.on('did-finish-load', () => this.sendFlowBarState())
    loadPage(this.flowBar, 'status')
  }

  setFlowBarEnabled(enabled: boolean): void {
    this.flowBarEnabled = enabled
    this.applyFlowBarVisibility()
  }

  setFlowBarState(state: FlowBarState): void {
    this.flowBarState = state
    if (state.kind === 'initializing') this.positionFlowBar()
    this.sendFlowBarState()
    this.applyFlowBarVisibility()
  }

  setFlowBarInteractive(interactive: boolean): void {
    this.flowBar.setIgnoreMouseEvents(!interactive, { forward: true })
  }

  private applyFlowBarVisibility(): void {
    const active = this.flowBarState.kind !== 'resting' && this.flowBarState.kind !== 'hidden'
    const visible = this.flowBarState.kind !== 'hidden' && (this.flowBarEnabled || active)
    if (visible && !this.flowBar.isVisible()) {
      this.positionFlowBar()
      this.flowBar.showInactive()
    } else if (!visible && this.flowBar.isVisible()) {
      this.flowBar.hide()
    }
  }

  private sendFlowBarState(): void {
    this.flowBar.webContents.send(Channel.flowBarState, this.flowBarState)
  }

  /** Bottom-center of the display that currently holds the mouse pointer. */
  private positionFlowBar(): void {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const { x, y, width, height } = display.workArea
    this.flowBar.setBounds({
      x: Math.round(x + (width - FLOW_BAR_WIDTH) / 2),
      y: Math.round(y + height - FLOW_BAR_HEIGHT - FLOW_BAR_BOTTOM_MARGIN),
      width: FLOW_BAR_WIDTH,
      height: FLOW_BAR_HEIGHT,
    })
  }

  showHub(): BrowserWindow {
    if (this.hub && !this.hub.isDestroyed()) {
      this.hub.show()
      this.hub.focus()
      return this.hub
    }
    const hub = new BrowserWindow({
      width: 1040,
      height: 720,
      minWidth: 820,
      minHeight: 560,
      show: false,
      title: 'OpenWispr',
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 18, y: 18 },
      backgroundColor: '#f7f5f2',
      webPreferences: { preload },
    })
    hub.once('ready-to-show', () => hub.show())
    hub.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url)
      return { action: 'deny' }
    })
    hub.on('closed', () => (this.hub = null))
    loadPage(hub, 'hub')
    this.hub = hub
    return hub
  }

  get hubWindow(): BrowserWindow | null {
    return this.hub && !this.hub.isDestroyed() ? this.hub : null
  }

  broadcast(channel: string, payload: unknown): void {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, payload)
  }
}
