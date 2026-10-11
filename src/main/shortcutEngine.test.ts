import { describe, expect, it } from 'vitest'
import { Key } from '../shared/keycodes'
import { DEFAULT_SHORTCUTS } from '../shared/types'
import { PTT_ABORT_WINDOW_MS, ShortcutEngine } from './shortcutEngine'

function setup() {
  let time = 0
  const engine = new ShortcutEngine(DEFAULT_SHORTCUTS, () => time)
  return {
    engine,
    advance: (ms: number) => (time += ms),
    down: (k: number) => engine.handleKey(k, true),
    up: (k: number) => engine.handleKey(k, false),
  }
}

describe('ShortcutEngine', () => {
  it('starts and ends push-to-talk on fn hold', () => {
    const { down, up, advance } = setup()
    expect(down(Key.fn)).toEqual(['pttStart'])
    advance(2000)
    expect(up(Key.fn)).toEqual(['pttEnd'])
  })

  it('locks into hands-free when space joins fn, then stops on the next fn press', () => {
    const { down, up, engine } = setup()
    expect(down(Key.fn)).toEqual(['pttStart'])
    expect(down(Key.space)).toEqual(['handsFreeLock'])
    expect(up(Key.space)).toEqual([])
    expect(up(Key.fn)).toEqual([])
    expect(engine.gestureMode).toBe('handsFree')
    expect(down(Key.fn)).toEqual(['handsFreeStop'])
    expect(up(Key.fn)).toEqual([])
    expect(engine.gestureMode).toBe('idle')
  })

  it('aborts push-to-talk when fn is used as a modifier', () => {
    const { down, up, advance } = setup()
    down(Key.fn)
    advance(100)
    expect(down(126)).toEqual(['pttAbort'])
    expect(up(126)).toEqual([])
    expect(up(Key.fn)).toEqual([])
    expect(down(Key.fn)).toEqual(['pttStart'])
  })

  it('ignores stray keys once push-to-talk is established', () => {
    const { down, up, advance } = setup()
    down(Key.fn)
    advance(PTT_ABORT_WINDOW_MS + 1)
    expect(down(126)).toEqual([])
    expect(up(Key.fn)).toEqual(['pttEnd'])
  })

  it('dismisses with Esc while recording', () => {
    const { down, engine } = setup()
    down(Key.fn)
    expect(down(Key.esc)).toEqual(['dismiss'])
    expect(engine.gestureMode).toBe('idle')
  })

  it('fires paste-last once per press', () => {
    const { down, up } = setup()
    expect(down(Key.ctrl)).toEqual([])
    expect(down(Key.cmd)).toEqual([])
    expect(down(Key.v)).toEqual(['pasteLast'])
    up(Key.v)
    expect(down(Key.v)).toEqual([])
  })

  it('ignores key repeats', () => {
    const { down } = setup()
    expect(down(Key.fn)).toEqual(['pttStart'])
    expect(down(Key.fn)).toEqual([])
  })
})
