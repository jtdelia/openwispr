import { Key } from '../shared/keycodes'
import type { Shortcuts } from '../shared/types'

export type Gesture =
  | 'pttStart'
  | 'pttEnd'
  /** Another key joined the push-to-talk key right away: the user was typing a key combo, not dictating. */
  | 'pttAbort'
  | 'handsFreeStart'
  /** Push-to-talk was upgraded to hands-free while held (e.g. fn, then Space). */
  | 'handsFreeLock'
  | 'handsFreeStop'
  | 'dismiss'
  | 'pasteLast'
  | 'copyLast'

export type GestureMode = 'idle' | 'ptt' | 'handsFree'

/** Keys pressed within this window after push-to-talk starts mean the user was using a key combo. */
export const PTT_ABORT_WINDOW_MS = 500

/**
 * Turns the raw key stream from the helper into dictation gestures. It tracks only keyboard
 * state; the dictation controller decides what a gesture means given the current dictation phase.
 */
export class ShortcutEngine {
  private held = new Set<number>()
  private mode: GestureMode = 'idle'
  /** Set after a one-shot gesture so nothing else fires until every key is released. */
  private suppressed = false
  private pttStartedAt = 0

  constructor(
    private shortcuts: Shortcuts,
    private readonly now: () => number = Date.now,
  ) {}

  get gestureMode(): GestureMode {
    return this.mode
  }

  setShortcuts(shortcuts: Shortcuts): void {
    this.shortcuts = shortcuts
  }

  /** Called when dictation ends without a keyboard gesture (click, error, Esc, time limit). */
  reset(): void {
    this.mode = 'idle'
    this.suppressed = this.held.size > 0
  }

  /** The helper's tap was re-enabled and may have missed key-ups. */
  clearHeld(): void {
    this.held.clear()
    this.suppressed = false
  }

  handleKey(keycode: number, down: boolean): Gesture[] {
    return down ? this.keyDown(keycode) : this.keyUp(keycode)
  }

  private matches(combo: readonly number[]): boolean {
    return combo.length > 0 && combo.length === this.held.size && combo.every((k) => this.held.has(k))
  }

  private keyDown(keycode: number): Gesture[] {
    if (this.held.has(keycode)) return []
    this.held.add(keycode)
    const { ptt, handsFree, pasteLast, copyLast } = this.shortcuts

    switch (this.mode) {
      case 'ptt': {
        if (keycode === Key.esc) return this.endWith('dismiss')
        if (this.matches(handsFree)) {
          this.mode = 'handsFree'
          return ['handsFreeLock']
        }
        if (!ptt.includes(keycode) && this.now() - this.pttStartedAt < PTT_ABORT_WINDOW_MS) {
          return this.endWith('pttAbort')
        }
        return []
      }
      case 'handsFree': {
        if (keycode === Key.esc) return this.endWith('dismiss')
        if (this.matches(ptt) || this.matches(handsFree)) return this.endWith('handsFreeStop')
        return []
      }
      case 'idle': {
        if (keycode === Key.esc && this.held.size === 1) return ['dismiss']
        if (this.suppressed) return []
        if (this.matches(ptt)) {
          this.mode = 'ptt'
          this.pttStartedAt = this.now()
          return ['pttStart']
        }
        if (this.matches(handsFree)) {
          this.mode = 'handsFree'
          this.suppressed = true
          return ['handsFreeStart']
        }
        if (this.matches(pasteLast)) return this.oneShot('pasteLast')
        if (this.matches(copyLast)) return this.oneShot('copyLast')
        return []
      }
      default: {
        const unreachable: never = this.mode
        throw new Error(`unhandled gesture mode ${String(unreachable)}`)
      }
    }
  }

  private keyUp(keycode: number): Gesture[] {
    this.held.delete(keycode)
    if (this.held.size === 0) this.suppressed = false
    if (this.mode === 'ptt' && this.shortcuts.ptt.includes(keycode)) {
      this.mode = 'idle'
      this.suppressed = this.held.size > 0
      return ['pttEnd']
    }
    return []
  }

  private endWith(gesture: Gesture): Gesture[] {
    this.mode = 'idle'
    this.suppressed = true
    return [gesture]
  }

  private oneShot(gesture: Gesture): Gesture[] {
    this.suppressed = true
    return [gesture]
  }
}
