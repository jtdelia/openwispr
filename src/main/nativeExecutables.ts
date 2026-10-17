import { join } from 'node:path'

/** A Swift executable the main process spawns. Packaging copies each one into the app's Resources. */
export interface NativeExecutable {
  name: string
  /** Directory holding the built executable during development, relative to the app path. */
  devBuildDir: string
}

export interface NativeRuntime {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
}

export const HELPER: NativeExecutable = { name: 'openwispr-helper', devBuildDir: 'native/helper/.build/release' }

export const MODEL_PROCESS: NativeExecutable = { name: 'openwispr-models', devBuildDir: 'native/models/.build/release' }

export function nativeExecutablePath(executable: NativeExecutable, runtime: NativeRuntime): string {
  if (runtime.isPackaged) return join(runtime.resourcesPath, executable.name)
  return join(runtime.appPath, executable.devBuildDir, executable.name)
}
