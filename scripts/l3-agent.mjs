#!/usr/bin/env node
// L3 deep-investigation bridge for a3s-sentry.
//
// Runs an a3s-code agent (the `@a3s-lab/code` SDK) with a directory of security skills to deeply
// investigate one flagged event, and prints a `{verdict,severity,reason}` JSON verdict on stdout.
// sentry's AgentJudge invokes this as: `l3-agent.mjs --skills <dir> --json -p "<investigation prompt>"`.
//
// The model is taken from the same env sentry passes to L2, so L2 and L3 share one LLM config:
//   A3S_SENTRY_LLM_URL   OpenAI-compatible base URL (…/v1)
//   A3S_SENTRY_LLM_KEY   API key
//   A3S_SENTRY_LLM_MODEL model id (default: glm5.1-w4a8)
//
// Requires `@a3s-lab/code` (npm i -g @a3s-lab/code, or a local install).

import { createRequire } from 'module'
import { execSync } from 'child_process'

const require = createRequire('/app/package.json')

function loadSdk() {
  try {
    return require('@a3s-lab/code')
  } catch {
    const groot = execSync('npm root -g').toString().trim()
    return require(groot + '/@a3s-lab/code')
  }
}

// --- args: -p <prompt> (or a bare trailing prompt), --skills <dir>, --json (ignored) ---
const argv = process.argv.slice(2)
let prompt = ''
let skills = null
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '-p') prompt = argv[++i]
  else if (argv[i] === '--skills') skills = argv[++i]
  else if (argv[i] === '--json') continue
  else if (!argv[i].startsWith('--')) prompt = argv[i]
}
if (!prompt) {
  console.error('l3-agent: no prompt (-p) given')
  process.exit(2)
}

// L3 LLM config: prefer dedicated A3S_SENTRY_L3_* (lets L3 use a different/stronger model than L2,
// and lets you run L3 without enabling sentry's L2), falling back to L2's A3S_SENTRY_LLM_*.
const url = process.env.A3S_SENTRY_L3_URL || process.env.A3S_SENTRY_LLM_URL || 'http://localhost:18051/v1'
const key = process.env.A3S_SENTRY_L3_KEY || process.env.A3S_SENTRY_LLM_KEY || ''
const model = process.env.A3S_SENTRY_L3_MODEL || process.env.A3S_SENTRY_LLM_MODEL || 'glm-5.2'

// a3s-code agent ACL — provider is matched by `name`; apiKey/baseUrl are camelCase on the model.
const acl = `id = "sentry-l3"
name = "Sentry L3 Security Investigator"
default_model = "openai/${model}"
providers "openai" {
  id = "openai"
  name = "openai"
  models "${model}" {
    id = "${model}"
    name = "${model}"
    apiKey = "${key}"
    baseUrl = "${url}"
  }
}`

function extractVerdict(text) {
  const s = text.indexOf('{')
  const e = text.lastIndexOf('}')
  if (s < 0 || e < s) return null
  try {
    return JSON.parse(text.slice(s, e + 1))
  } catch {
    return null
  }
}

try {
  const { Agent } = loadSdk()
  const agent = await Agent.create(acl)
  const opts = { planningMode: 'disabled' }
  if (skills) opts.skillDirs = [skills]
  const session = agent.session('.', opts)
  const result = await session.send(prompt)
  session.close()
  const verdict = extractVerdict(result.text)
  if (!verdict || !verdict.verdict) {
    console.error('l3-agent: no parseable verdict in agent output')
    process.exit(2)
  }
  process.stdout.write(JSON.stringify(verdict) + '\n')
} catch (e) {
  console.error('l3-agent error:', e && e.message ? e.message : e)
  process.exit(1)
}
