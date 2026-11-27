import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildPluginTag,
  discoverWorkspacePlugins,
  extractChangelogNotes,
  readChangesetIgnore,
  resolveSingleTarget,
  selectPendingReleases,
} from './release-targets.mjs'

function createFixtureWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-release-targets-'))
  mkdirSync(join(root, '.changeset'), { recursive: true })
  writeFileSync(
    join(root, '.changeset', 'config.json'),
    JSON.stringify({
      ignore: ['@charonx/dsh-immersive-translate', '@charonx/dsh-model-studio', '@charonx/dsh-media-station'],
    }),
  )

  const writePkg = (dirName, manifest) => {
    const dir = join(root, 'plugins', dirName)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  }

  writePkg('dsh-manager', { name: '@charonx/dsh-manager', version: '0.1.1' })
  writePkg('skills-manager', {
    name: '@charonx/dsh-skills-manager',
    version: '0.1.4',
    scripts: { 'smoke:client': 'node scripts/smoke-client.mjs' },
  })
  writePkg('immersive-translate', { name: '@charonx/dsh-immersive-translate', version: '0.0.1' })
  writePkg('media-station', { name: '@charonx/dsh-media-station', version: '0.1.0' })
  writePkg('internal-only', { name: '@charonx/dsh-internal', version: '0.1.0', private: true })

  return root
}

test('readChangesetIgnore and discoverWorkspacePlugins exclude ignored and private packages', () => {
  const root = createFixtureWorkspace()
  try {
    const ignore = readChangesetIgnore(root)
    assert.equal(ignore.has('@charonx/dsh-immersive-translate'), true)

    const plugins = discoverWorkspacePlugins(root)
    assert.deepEqual(
      plugins.map((p) => p.dirName),
      ['dsh-manager', 'skills-manager'],
    )
    assert.equal(plugins[0].hasSmokeClient, false)
    assert.equal(plugins[1].hasSmokeClient, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('selectPendingReleases returns only versions not yet published on npm', () => {
  const plugins = [
    { dirName: 'dsh-manager', relDir: 'plugins/dsh-manager', name: '@charonx/dsh-manager', version: '0.1.1' },
    { dirName: 'skills-manager', relDir: 'plugins/skills-manager', name: '@charonx/dsh-skills-manager', version: '0.1.4' },
  ]
  const published = new Set(['@charonx/dsh-skills-manager@0.1.4'])
  const tags = new Set(['dsh-manager-v0.1.1'])

  const pending = selectPendingReleases({
    plugins,
    isVersionPublished: (name, version) => published.has(`${name}@${version}`),
    hasTag: (tag) => tags.has(tag),
  })

  assert.deepEqual(pending, [
    {
      dirName: 'dsh-manager',
      relDir: 'plugins/dsh-manager',
      name: '@charonx/dsh-manager',
      version: '0.1.1',
      tag: 'dsh-manager-v0.1.1',
      hasTag: true,
    },
  ])
})

test('resolveSingleTarget supports both plugin directory names and <plugin>-v<version> tags', () => {
  const root = createFixtureWorkspace()
  try {
    const byDir = resolveSingleTarget(root, 'skills-manager')
    assert.equal(byDir.tag, 'skills-manager-v0.1.4')

    const byTag = resolveSingleTarget(root, 'dsh-manager-v0.1.1')
    assert.equal(byTag.name, '@charonx/dsh-manager')

    assert.throws(
      () => resolveSingleTarget(root, 'dsh-manager-v9.9.9'),
      /Tag version \(9\.9\.9\) does not match/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('extractChangelogNotes extracts matching version block cleanly', () => {
  const changelog = `# @charonx/dsh-manager

## 0.1.2

### Patch Changes

- Fix release tag check

## v0.1.1

- Initial release
`
  assert.equal(extractChangelogNotes(changelog, '0.1.2'), '### Patch Changes\n\n- Fix release tag check\n')
  assert.equal(extractChangelogNotes(changelog, '0.1.1'), '- Initial release\n')
  assert.equal(extractChangelogNotes(changelog, '0.9.9'), null)
  assert.equal(buildPluginTag('external-agents', '0.2.0'), 'external-agents-v0.2.0')
})
