/** @type {import('electron-builder').Configuration} */
export default {
  appId: 'io.github.jtdelia.openwispr',
  productName: 'OpenWispr',
  electronDist: 'node_modules/electron/dist',
  npmRebuild: false,
  forceCodeSigning: true,
  files: ['out/**/*', 'package.json'],
  directories: { output: 'dist' },
  artifactName: '${productName}-${version}-${arch}.${ext}',
  // Every native executable the main process spawns, launched from Resources when packaged.
  extraResources: [
    { from: 'native/helper/.build/release/openwispr-helper', to: 'openwispr-helper' },
    { from: 'native/models/.build/release/openwispr-models', to: 'openwispr-models' },
    // MLX's Metal kernels; MLX looks for them next to the executable.
    { from: 'native/models/.build/release/mlx.metallib', to: 'mlx.metallib' },
  ],
  mac: {
    target: [{ target: 'dmg', arch: ['arm64'] }],
    category: 'public.app-category.productivity',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    notarize: process.env.OPENWISPR_NOTARIZE === 'true',
    extendInfo: {
      NSMicrophoneUsageDescription: 'OpenWispr listens to your microphone while you dictate or record a meeting.',
      NSSpeechRecognitionUsageDescription: 'OpenWispr turns your speech into text on this Mac.',
      NSAudioCaptureUsageDescription: 'OpenWispr records call audio for the Notetaker.',
    },
  },
  dmg: {
    title: '${productName} ${version}',
    contents: [
      { x: 130, y: 220, type: 'file' },
      { x: 410, y: 220, type: 'link', path: '/Applications' },
    ],
  },
}
