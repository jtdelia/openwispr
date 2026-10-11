import { describe, expect, it } from 'vitest'
import { HELPER, nativeExecutablePath } from './nativeExecutables'

describe('nativeExecutablePath', () => {
  it('launches the helper from the app bundle Resources when packaged', () => {
    const path = nativeExecutablePath(HELPER, {
      isPackaged: true,
      resourcesPath: '/Applications/OpenWispr.app/Contents/Resources',
      appPath: '/Applications/OpenWispr.app/Contents/Resources/app.asar',
    })
    expect(path).toBe('/Applications/OpenWispr.app/Contents/Resources/openwispr-helper')
  })

  it('launches the helper from its Swift build output when running unpackaged', () => {
    const path = nativeExecutablePath(HELPER, {
      isPackaged: false,
      resourcesPath: '/repo/node_modules/electron/dist/Electron.app/Contents/Resources',
      appPath: '/repo',
    })
    expect(path).toBe('/repo/native/helper/.build/release/openwispr-helper')
  })
})
