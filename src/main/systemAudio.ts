import { app, desktopCapturer, session } from 'electron'

/**
 * How Chromium can capture system audio on this macOS version: Core Audio process taps from 14.4,
 * ScreenCaptureKit on 13.0–14.3. Same version gate as Wispr Flow 1.6.
 */
export type SystemAudioCapability = 'process_tap' | 'screen_capture_kit' | 'unsupported'

export function systemAudioCapability(): SystemAudioCapability {
  if (process.platform !== 'darwin') return 'unsupported'
  const [major = 0, minor = 0] = process.getSystemVersion().split('.').map(Number)
  if (major > 14 || (major === 14 && minor >= 4)) return 'process_tap'
  if (major >= 13) return 'screen_capture_kit'
  return 'unsupported'
}

/** Chromium feature switches must be appended before the app is ready. */
export function enableSystemAudioFeatures(): void {
  const capability = systemAudioCapability()
  if (capability === 'unsupported') return
  const loopback =
    capability === 'process_tap' ? 'MacCatapSystemAudioLoopbackCapture' : 'MacSckSystemAudioLoopbackOverride'
  app.commandLine.appendSwitch('enable-features', `${loopback},MacLoopbackAudioForScreenShare`)
}

/** Answers the renderer's `getDisplayMedia({ audio: true })` with a system-audio loopback stream. */
export function installSystemAudioHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    const capability = systemAudioCapability()
    switch (capability) {
      case 'process_tap':
        // Electron forwards this as a Chromium audio device; `loopbackAllDevices` is the process-tap
        // device that mixes every app's output. Electron's typings only list the Windows loopback strings.
        callback({
          audio: { id: 'loopbackAllDevices', name: 'All loopback devices' } as unknown as Electron.Streams['audio'],
        })
        return
      case 'screen_capture_kit':
        // ScreenCaptureKit only delivers audio alongside a display; the renderer drops the video track.
        void desktopCapturer.getSources({ types: ['screen'] }).then(
          ([screen]) => callback(screen ? { video: screen, audio: 'loopback' } : {}),
          () => callback({}),
        )
        return
      case 'unsupported':
        callback({})
        return
      default: {
        const unreachable: never = capability
        throw new Error(`unhandled system audio capability ${String(unreachable)}`)
      }
    }
  })
}
