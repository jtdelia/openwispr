/** macOS virtual key codes, as delivered by the helper's event tap. */
export const Key = {
  fn: 63,
  cmd: 55,
  cmdRight: 54,
  shift: 56,
  shiftRight: 60,
  opt: 58,
  optRight: 61,
  ctrl: 59,
  ctrlRight: 62,
  capsLock: 57,
  space: 49,
  esc: 53,
  c: 8,
  v: 9,
} as const

export const MODIFIER_KEYS = new Set<number>([
  Key.fn,
  Key.cmd,
  Key.cmdRight,
  Key.shift,
  Key.shiftRight,
  Key.opt,
  Key.optRight,
  Key.ctrl,
  Key.ctrlRight,
  Key.capsLock,
])

const LABELS: Record<number, string> = {
  [Key.fn]: 'fn',
  [Key.cmd]: '⌘',
  [Key.cmdRight]: 'Right ⌘',
  [Key.shift]: '⇧',
  [Key.shiftRight]: 'Right ⇧',
  [Key.opt]: '⌥',
  [Key.optRight]: 'Right ⌥',
  [Key.ctrl]: '⌃',
  [Key.ctrlRight]: 'Right ⌃',
  [Key.capsLock]: 'Caps Lock',
  [Key.space]: 'Space',
  [Key.esc]: 'Esc',
  36: 'Return',
  48: 'Tab',
  51: 'Delete',
  123: '←',
  124: '→',
  125: '↓',
  126: '↑',
  122: 'F1',
  120: 'F2',
  99: 'F3',
  118: 'F4',
  96: 'F5',
  97: 'F6',
  98: 'F7',
  100: 'F8',
  101: 'F9',
  109: 'F10',
  103: 'F11',
  111: 'F12',
  0: 'A', 11: 'B', 8: 'C', 2: 'D', 14: 'E', 3: 'F', 5: 'G', 4: 'H', 34: 'I', 38: 'J', 40: 'K', 37: 'L', 46: 'M',
  45: 'N', 31: 'O', 35: 'P', 12: 'Q', 15: 'R', 1: 'S', 17: 'T', 32: 'U', 9: 'V', 13: 'W', 7: 'X', 16: 'Y', 6: 'Z',
  29: '0', 18: '1', 19: '2', 20: '3', 21: '4', 23: '5', 22: '6', 26: '7', 28: '8', 25: '9',
  27: '-', 24: '=', 33: '[', 30: ']', 42: '\\', 41: ';', 39: "'", 43: ',', 47: '.', 44: '/', 50: '`',
}

export function keyLabel(keycode: number): string {
  return LABELS[keycode] ?? `Key ${keycode}`
}

/** Modifiers first (fn, ⌃, ⌥, ⇧, ⌘), then other keys. */
export function comboLabel(combo: readonly number[]): string {
  const order = [Key.fn, Key.ctrl, Key.ctrlRight, Key.opt, Key.optRight, Key.shift, Key.shiftRight, Key.cmd, Key.cmdRight]
  const rank = (k: number) => {
    const i = order.indexOf(k as (typeof order)[number])
    return i === -1 ? order.length + k : i
  }
  return [...combo].sort((a, b) => rank(a) - rank(b)).map(keyLabel).join(' + ')
}
