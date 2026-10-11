import type { Sound } from '../../shared/api'

let context: AudioContext | null = null

function tone(ctx: AudioContext, frequency: number, start: number, duration: number, gain = 0.08): void {
  const osc = ctx.createOscillator()
  const amp = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(frequency, ctx.currentTime + start)
  amp.gain.setValueAtTime(0, ctx.currentTime + start)
  amp.gain.linearRampToValueAtTime(gain, ctx.currentTime + start + 0.01)
  amp.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + duration)
  osc.connect(amp).connect(ctx.destination)
  osc.start(ctx.currentTime + start)
  osc.stop(ctx.currentTime + start + duration + 0.02)
}

/** Short synthesized cues so the app ships no audio assets. */
export function playSound(sound: Sound): void {
  context ??= new AudioContext()
  const ctx = context
  switch (sound) {
    case 'start':
      tone(ctx, 660, 0, 0.09)
      tone(ctx, 880, 0.07, 0.12)
      return
    case 'stop':
      tone(ctx, 880, 0, 0.09)
      tone(ctx, 600, 0.07, 0.12)
      return
    case 'lock':
      tone(ctx, 880, 0, 0.07)
      tone(ctx, 880, 0.1, 0.07)
      tone(ctx, 1175, 0.2, 0.12)
      return
    case 'error':
      tone(ctx, 220, 0, 0.25, 0.1)
      return
    default: {
      const unreachable: never = sound
      throw new Error(`unhandled sound ${String(unreachable)}`)
    }
  }
}
