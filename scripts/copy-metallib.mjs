#!/usr/bin/env node
// Copies MLX's compiled Metal kernels next to the built model process as mlx.metallib, where MLX looks
// for them; without it MLX chat models can't run. Packaging ships the file beside the executable too.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const binPath = execFileSync('swift', ['build', '-c', 'release', '--package-path', 'native/models', '--show-bin-path'], {
  encoding: 'utf8',
}).trim()
const source = join(binPath, 'mlx-swift_Cmlx.bundle/Contents/Resources/default.metallib')
if (!existsSync(source)) {
  console.error(
    [
      `error: MLX's Metal library wasn't built (${source} is missing).`,
      'Xcode ships the Metal compiler separately; install it once with',
      '  xcodebuild -downloadComponent MetalToolchain',
      'then run npm run models:build again.',
    ].join('\n'),
  )
  process.exit(1)
}
copyFileSync(source, join(binPath, 'mlx.metallib'))
