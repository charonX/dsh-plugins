#!/usr/bin/env node
/**
 * Deterministic repository hygiene & verify-doc consistency gate for `dsh-plugins`.
 * Fails with actionable fix instructions on:
 * 1. Tracked build artifacts (`plugins/<name>/{lib,client,dist,coverage}/**`) or plugin-local `pnpm-lock.yaml`.
 * 2. Orphaned plugin-local `pnpm-lock.yaml` files inside workspace packages.
 * 3. Client UI violations: bare hex colors outside `var(...)` or Unicode emojis in `plugins/<name>/src/client`.
 * 4. Verify doc drift: broken relative links in `docs/verify/features/README.md` or stale assertions of removed features (`briefings`, `PromptStudio`, `CrewSection`, `dsh_manager_team_member_upsert`, `dsh_manager_flow_config_upsert`).
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const dshRoot = resolve(import.meta.dirname, '..')
const issues = []

function addIssue(category, location, detail, fix) {
  issues.push({ category, location, detail, fix })
}

function walkFiles(dir, predicate, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkFiles(full, predicate, out)
    } else if (predicate(full, entry.name)) {
      out.push(full)
    }
  }
  return out
}

// 1. Git tracked build artifacts & lockfiles
try {
  const trackedRaw = execFileSync('git', ['-C', dshRoot, 'ls-files', '-z'], { encoding: 'utf8' })
  const trackedFiles = trackedRaw.split('\0').filter(Boolean)
  const badArtifactRe = /^plugins\/[^/]+\/(lib|client|dist|coverage)\//
  const badTrackedDirs = new Set()

  for (const file of trackedFiles) {
    const match = file.match(badArtifactRe)
    if (match) {
      badTrackedDirs.add(file.split('/').slice(0, 3).join('/'))
    } else if (/^plugins\/[^/]+\/pnpm-lock\.yaml$/u.test(file)) {
      addIssue(
        'tracked-lockfile',
        file,
        'Workspace plugin must not track its own pnpm-lock.yaml (root pnpm-lock.yaml is the single source of truth).',
        `git -C ${dshRoot} rm --cached ${file} && rm -f ${join(dshRoot, file)}`,
      )
    }
  }

  for (const dir of [...badTrackedDirs].sort()) {
    const pluginDir = dir.split('/').slice(0, 2).join('/')
    addIssue(
      'tracked-build-artifact',
      dir,
      'Build output directory is tracked by Git (violates docs/git-flow.md).',
      `git -C ${dshRoot} rm -r --cached ${dir} && ensure /${dir.split('/')[2]}/ is listed in ${pluginDir}/.gitignore`,
    )
  }
} catch (error) {
  addIssue(
    'git-ls-files',
    dshRoot,
    `Failed to inspect git index: ${error instanceof Error ? error.message : String(error)}`,
    'Run inside a valid git checkout of dsh-plugins.',
  )
}

// 2. Untracked orphan plugin-local pnpm-lock.yaml
const pluginsDir = join(dshRoot, 'plugins')
if (existsSync(pluginsDir)) {
  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const lockPath = join(pluginsDir, entry.name, 'pnpm-lock.yaml')
    if (existsSync(lockPath)) {
      addIssue(
        'orphan-plugin-lockfile',
        relative(dshRoot, lockPath),
        'Workspace package contains a local pnpm-lock.yaml that can diverge from root pnpm-lock.yaml.',
        `rm -f ${lockPath}`,
      )
    }
  }
}

// 3. UI compliance scan in plugins/*/src/client
const emojiRe = /[\u{1F300}-\u{1FAFF}]/u
const varWithHexRe = /var\([^)]*#[0-9a-fA-F]{3,8}\b[^)]*\)/g
const bareHexRe = /#[0-9a-fA-F]{3,8}\b/g

if (existsSync(pluginsDir)) {
  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const clientDir = join(pluginsDir, entry.name, 'src', 'client')
    const clientFiles = walkFiles(clientDir, (full) => /\.(ts|tsx|css)$/u.test(full))
    for (const file of clientFiles) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, idx) => {
        const trimmed = line.trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) return
        const rel = relative(dshRoot, file)

        const emojiMatch = line.match(emojiRe)
        if (emojiMatch) {
          addIssue(
            'ui-emoji',
            `${rel}:${idx + 1}`,
            `Disallowed emoji "${emojiMatch[0]}" found in plugin client source.`,
            'Replace emojis with plain text labels or native DSH badges / --dsw-alias-state-* tokens.',
          )
        }

        const withoutVarFallbacks = line.replace(varWithHexRe, '')
        const hexMatches = withoutVarFallbacks.match(bareHexRe)
        if (hexMatches) {
          addIssue(
            'ui-bare-hex',
            `${rel}:${idx + 1}`,
            `Bare hex color ${hexMatches.join(', ')} found outside var(--dsw-alias-*, ...).`,
            'Use official DSH design tokens (var(--dsw-alias-*)) instead of standalone hex colors.',
          )
        }
      })
    }
  }
}

// 4. Verify docs consistency & dead-feature guard
const featuresDir = join(dshRoot, 'docs', 'verify', 'features')
const featuresIndex = join(featuresDir, 'README.md')
if (existsSync(featuresIndex)) {
  const indexText = readFileSync(featuresIndex, 'utf8')
  for (const match of indexText.matchAll(/\[[^\]]+\]\(([^)]+\.md)\)/g)) {
    const target = resolve(featuresDir, match[1])
    if (!existsSync(target) || !statSync(target).isFile()) {
      addIssue(
        'verify-doc-broken-link',
        relative(dshRoot, featuresIndex),
        `Broken verify feature link: ${match[1]}`,
        `Create ${relative(dshRoot, target)} or remove the stale row from docs/verify/features/README.md.`,
      )
    }
  }
}

const removedMarkers = [
  { token: '`briefings`', label: 'removed briefings tab' },
  { token: 'PromptStudio', label: 'removed PromptStudio UI' },
  { token: '提示词工作台', label: 'removed PromptStudio feature doc' },
  { token: 'CrewSection', label: 'removed CrewSection UI' },
  { token: 'dsh_manager_team_member_upsert', label: 'removed dsh_manager_team_member_upsert tool' },
  { token: 'dsh_manager_flow_config_upsert', label: 'removed dsh_manager_flow_config_upsert tool' },
]

for (const docFile of walkFiles(featuresDir, (full) => full.endsWith('.md'))) {
  const rel = relative(dshRoot, docFile)
  const lines = readFileSync(docFile, 'utf8').split('\n')
  lines.forEach((line, idx) => {
    for (const marker of removedMarkers) {
      if (line.includes(marker.token) && !/已移除|已下线|removed/iu.test(line)) {
        addIssue(
          'verify-doc-stale-ref',
          `${rel}:${idx + 1}`,
          `Verify doc still documents ${marker.label} (${marker.token}).`,
          `Update ${rel} to match current dsh-manager Flow IR v3 / 5-Tab IA / Ticket Workbench behavior.`,
        )
      }
    }
  })
}

if (issues.length === 0) {
  console.log('[PASS] repo hygiene & verify-doc checks passed (0 issues)')
  process.exit(0)
}

console.error(`[FAIL] repo hygiene check found ${issues.length} issue(s):`)
for (const item of issues) {
  console.error(`- [${item.category}] ${item.location}: ${item.detail}`)
  console.error(`  fix: ${item.fix}`)
}
process.exit(1)
