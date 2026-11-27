#!/usr/bin/env node
/**
 * Release target discovery, npm/tag state resolution, and changelog extraction
 * for the `dsh-plugins` monorepo release pipeline.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const NPM_REGISTRY = 'https://registry.npmjs.org'

/**
 * Read ignored package names from `.changeset/config.json`.
 * @param {string} rootDir
 * @returns {Set<string>}
 */
export function readChangesetIgnore(rootDir) {
  const configPath = join(rootDir, '.changeset', 'config.json')
  if (!existsSync(configPath)) return new Set()
  const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
  const ignore = Array.isArray(parsed?.ignore) ? parsed.ignore : []
  return new Set(ignore.filter((entry) => typeof entry === 'string'))
}

/**
 * Discover all non-private, non-ignored workspace plugins under `plugins/*`.
 * @param {string} rootDir
 * @param {{ ignore?: Set<string> }} [options]
 */
export function discoverWorkspacePlugins(rootDir, options = {}) {
  const ignore = options.ignore ?? readChangesetIgnore(rootDir)
  const pluginsRoot = join(rootDir, 'plugins')
  if (!existsSync(pluginsRoot)) return []

  const results = []
  for (const entry of readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const relDir = `plugins/${entry.name}`
    const manifestPath = join(rootDir, relDir, 'package.json')
    if (!existsSync(manifestPath)) continue

    const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (pkg.private === true) continue
    if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') continue
    if (ignore.has(pkg.name)) continue

    results.push({
      dirName: entry.name,
      relDir,
      name: pkg.name,
      version: pkg.version,
      hasSmokeClient: Boolean(pkg.scripts?.['smoke:client']),
    })
  }
  return results.sort((a, b) => a.dirName.localeCompare(b.dirName))
}

/**
 * Resolve a single plugin directory or `<plugin>-v<version>` tag into release metadata.
 * @param {string} rootDir
 * @param {string} input - Either plugin directory name (`skills-manager`) or release tag (`skills-manager-v0.1.4`).
 */
export function resolveSingleTarget(rootDir, input) {
  let dirName = input
  let expectedVersion = null

  const tagMatch = input.match(/^(.+)-v([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)$/)
  if (tagMatch && existsSync(join(rootDir, 'plugins', tagMatch[1], 'package.json'))) {
    dirName = tagMatch[1]
    expectedVersion = tagMatch[2]
  }

  const relDir = `plugins/${dirName}`
  const manifestPath = join(rootDir, relDir, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`Plugin directory ${relDir} does not exist`)
  }

  const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (pkg.private === true) {
    throw new Error(`Package ${pkg.name} (${relDir}) is marked private`)
  }
  if (expectedVersion !== null && expectedVersion !== pkg.version) {
    throw new Error(`Tag version (${expectedVersion}) does not match ${relDir}/package.json (${pkg.version})`)
  }

  return {
    dirName,
    relDir,
    name: pkg.name,
    version: pkg.version,
    tag: buildPluginTag(dirName, pkg.version),
    hasSmokeClient: Boolean(pkg.scripts?.['smoke:client']),
  }
}

/**
 * Build the monorepo git tag name for a plugin release.
 * @param {string} dirName
 * @param {string} version
 */
export function buildPluginTag(dirName, version) {
  return `${dirName}-v${version}`
}

/**
 * Extract the markdown section for `version` from a Changesets-style CHANGELOG.md.
 * Matches both `## 0.1.4` and `## v0.1.4`.
 * @param {string} changelogText
 * @param {string} version
 * @returns {string | null}
 */
export function extractChangelogNotes(changelogText, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = changelogText.match(
    new RegExp(`^##\\s+v?${escaped}\\b[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s+|(?![\\s\\S]))`, 'm'),
  )
  const body = match?.[1]?.trim()
  return body ? `${body}\n` : null
}

/**
 * Select plugins whose current `package.json` version is not yet published on npm.
 * @param {{
 *   plugins: Array<{ dirName: string, relDir: string, name: string, version: string, hasSmokeClient?: boolean }>,
 *   isVersionPublished: (name: string, version: string) => boolean,
 *   hasTag: (tag: string) => boolean,
 * }} params
 */
export function selectPendingReleases({ plugins, isVersionPublished, hasTag }) {
  const pending = []
  for (const plugin of plugins) {
    if (isVersionPublished(plugin.name, plugin.version)) continue
    const tag = buildPluginTag(plugin.dirName, plugin.version)
    pending.push({
      ...plugin,
      tag,
      hasTag: hasTag(tag),
    })
  }
  return pending
}

function checkNpmVersionExists(name, version) {
  try {
    const out = execFileSync(
      'npm',
      ['view', `${name}@${version}`, 'version', '--registry', NPM_REGISTRY],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim()
    return out === version
  } catch (error) {
    const stderr = String(error?.stderr ?? '')
    const stdout = String(error?.stdout ?? '')
    const combined = `${stdout}\n${stderr}`
    if (/E404|404 Not Found|No match found/i.test(combined)) {
      return false
    }
    throw new Error(`Failed to query npm for ${name}@${version}: ${combined.trim() || error.message}`)
  }
}

function checkGitTagExists(rootDir, tag) {
  const local = execFileSync('git', ['-C', rootDir, 'tag', '-l', tag], { encoding: 'utf8' }).trim()
  return local === tag
}

function runCli(argv) {
  const rootDir = resolve(import.meta.dirname, '..')
  const [cmd, ...rest] = argv

  if (cmd === '--list-releaseable') {
    console.log(JSON.stringify(discoverWorkspacePlugins(rootDir)))
    return
  }

  if (cmd === '--pending-json') {
    const plugins = discoverWorkspacePlugins(rootDir)
    const pending = selectPendingReleases({
      plugins,
      isVersionPublished: checkNpmVersionExists,
      hasTag: (tag) => checkGitTagExists(rootDir, tag),
    })
    console.log(JSON.stringify(pending))
    return
  }

  if (cmd === '--resolve-single') {
    const input = rest[0]
    if (!input) throw new Error('Usage: --resolve-single <plugin-or-tag>')
    console.log(JSON.stringify(resolveSingleTarget(rootDir, input)))
    return
  }

  if (cmd === '--extract-notes') {
    const [changelogPath, version, outPath] = rest
    if (!changelogPath || !version || !outPath) {
      throw new Error('Usage: --extract-notes <changelogPath> <version> <outPath>')
    }
    if (existsSync(changelogPath)) {
      const notes = extractChangelogNotes(readFileSync(changelogPath, 'utf8'), version)
      if (notes) writeFileSync(outPath, notes, 'utf8')
    }
    return
  }

  throw new Error(`Unknown command: ${cmd ?? '(none)'}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2))
}
