import type { PermissionStatus } from './types'

/** What to do when the microphone is not usable, or null when it is. */
export function microphoneHelp(status: PermissionStatus['microphone']): string | null {
  switch (status) {
    case 'granted':
      return null
    case 'not-determined':
      // macOS attributes a child process's request to the app that launched it and may not prompt at all.
      return (
        "macOS didn't show its permission prompt. That happens when OpenWispr is started from a terminal or " +
        'editor, because macOS asks on behalf of that app. Run `npm run start:standalone`, or allow that app ' +
        'in System Settings → Privacy & Security → Microphone.'
      )
    case 'denied':
    case 'restricted':
    case 'unknown':
      return 'Turn it on in System Settings → Privacy & Security → Microphone ("Electron" in development).'
    default: {
      const unreachable: never = status
      throw new Error(`unhandled microphone status ${String(unreachable)}`)
    }
  }
}
