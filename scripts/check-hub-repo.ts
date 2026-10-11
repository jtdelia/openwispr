// Runs the compatibility check for pasted Hugging Face repos against the live Hub, as Settings does.
// Usage: npm run models:check-repo -- <repo id or URL> [...]
// Only the info call, file listings and small config files are fetched; no weights are downloaded.
import { checkHubRepo } from '../src/main/hubCompatibility'
import { formatBytes } from '../src/renderer/hub/format'

const inputs = process.argv.slice(2).filter((arg) => arg !== '--')
if (inputs.length === 0) {
  console.error('Usage: npm run models:check-repo -- <repo id or URL> [...]')
  process.exit(1)
}

for (const input of inputs) {
  const started = Date.now()
  const check = await checkHubRepo(fetch, input)
  const ms = Date.now() - started
  switch (check.kind) {
    case 'compatible': {
      const { model } = check
      console.log(`✓ ${input} (${ms} ms)`)
      console.log(`  ${model.task}, ${check.summary}`)
      console.log(
        `  ${formatBytes(model.sizeBytes)} download, about ${formatBytes(model.memoryBytes)} memory, ${model.speed}, ${model.languages}`,
      )
      for (const source of model.sources) {
        console.log(`  from ${source.repo}@${source.revision.slice(0, 7)}: ${source.files?.join(', ') ?? '(whole repo)'}`)
      }
      if (model.chatTemplateContext) console.log(`  chat template context ${JSON.stringify(model.chatTemplateContext)}`)
      break
    }
    case 'severalModels':
      console.log(`… ${input} (${ms} ms): ${check.message}: ${check.folders.join(', ')}`)
      break
    case 'rejected':
      console.log(`✗ ${input} (${ms} ms) [${check.reason}]: ${check.message}`)
      break
    default: {
      const unreachable: never = check
      throw new Error(`unhandled repo check ${JSON.stringify(unreachable)}`)
    }
  }
}
