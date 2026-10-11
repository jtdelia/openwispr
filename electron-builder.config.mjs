/** @type {import('electron-builder').Configuration} */
export default {
  appId: 'io.github.jtdelia.openwispr',
  productName: 'OpenWispr',
  electronDist: 'node_modules/electron/dist',
  npmRebuild: false,
  forceCodeSigning: true,
  files: ['out/**/*', 'package.json'],
  directories: { output: 'dist' },
  // Every native executable the main process spawns, launched from Resources when packaged.
  extraResources: [{ from: 'native/helper/.build/release/openwispr-helper', to: 'openwispr-helper' }],
  mac: {
    target: 'dir',
    category: 'public.app-category.productivity',
    hardenedRuntime: false,
    gatekeeperAssess: false,
    notarize: false,
    extendInfo: {
      NSMicrophoneUsageDescription: 'OpenWispr listens to your microphone while you dictate or record a meeting.',
      NSSpeechRecognitionUsageDescription: 'OpenWispr turns your speech into text on this Mac.',
      NSAudioCaptureUsageDescription: 'OpenWispr records call audio for the Notetaker.',
    },
  },
}
