#!/usr/bin/env node
// Builds dist/mac-<arch>/OpenWispr.app signed with the Apple Development identity from the keychain.
// macOS keys privacy grants to the signing identity and bundle id, so an unsigned build would lose them.
import { execFileSync } from 'node:child_process'

function run(command, args, options = {}) {
  try {
    execFileSync(command, args, { stdio: 'inherit', ...options })
  } catch (error) {
    process.exit(error.status ?? 1)
  }
}

function findSigningIdentity() {
  const override = process.env.OPENWISPR_SIGNING_IDENTITY
  if (override) return override
  const output = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
  const match = output.match(/"(Apple Development: [^"]+)"/)
  return match?.[1] ?? null
}

const identity = findSigningIdentity()
if (!identity) {
  console.error(
    [
      'error: no "Apple Development" code signing identity found in the keychain.',
      '',
      'OpenWispr must be signed so macOS keeps its permission grants across rebuilds.',
      'Create one in Xcode → Settings → Accounts → Manage Certificates → + → Apple Development,',
      'or set OPENWISPR_SIGNING_IDENTITY to the name of another identity listed by',
      '  security find-identity -v -p codesigning',
    ].join('\n'),
  )
  process.exit(1)
}

console.log(`Signing with "${identity}"`)
run('npm', ['run', 'build'])
run('npx', ['electron-builder', '--mac', '--dir', '--config', 'electron-builder.config.mjs', `-c.mac.identity=${identity}`], {
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
})
