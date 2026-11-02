import { Context } from '@deepseek-ai/cordis'
import SkillRegistry, { type SkillCandidate, type SkillLookupOptions, type SkillProvider } from '@deepseek-ai/dsh-skill'
import { describe, expect, it } from 'vitest'
import { LibrarySkillProvider } from '../src/provider.ts'
import { StateStore } from '../src/state.ts'
import { skillFields, tempTree, writeSkill } from './helpers.ts'

const silentLogger = { warn: () => {} }

/** A competing provider that stands in for project-local skills. */
class FixedProvider implements SkillProvider {
  readonly name = 'fixed'

  constructor(private readonly candidates: readonly SkillCandidate[]) {}

  async list(_options: SkillLookupOptions): Promise<readonly SkillCandidate[]> {
    return this.candidates
  }

  async get(candidate: SkillCandidate): Promise<undefined> {
    void candidate
    return undefined
  }
}

describe('registration with the real skill registry', () => {
  it('serves library skills through ctx.skills and reloads after a state change', async () => {
    const tree = tempTree()
    try {
      writeSkill(tree.path('library', 'src'), skillFields('demo', 'Demo skill.'), 'Do the demo.')
      const state = new StateStore(tree.path('state.json'), silentLogger)
      const ctx = new Context()
      await ctx.plugin(SkillRegistry)
      let control: { invalidate(): void } | undefined
      ctx.effect(() => ctx.skills.registerProvider((registration) => {
        control = registration
        return new LibrarySkillProvider(
          {
            libraryDir: tree.path('library'),
            providerName: 'skills-manager',
            rank: 450,
            readState: () => state.read(),
            logger: silentLogger,
          },
          registration,
        )
      }))

      const listed = await ctx.skills.list()
      expect(listed.map((skill) => [skill.name, skill.provider, skill.source]))
        .toEqual([['demo', 'skills-manager', 'skills-manager']])
      expect((await ctx.skills.get('demo'))?.content).toBe('Do the demo.')

      state.patchSkill('src', 'src', { enabled: false })
      control?.invalidate()
      expect(await ctx.skills.list()).toEqual([])
    } finally {
      tree.cleanup()
    }
  })

  it('loses a name collision to a lower-ranked provider', async () => {
    const tree = tempTree()
    try {
      writeSkill(tree.path('library'), skillFields('shared', 'Library copy.'), 'library body')
      const state = new StateStore(tree.path('state.json'), silentLogger)
      const ctx = new Context()
      await ctx.plugin(SkillRegistry)
      ctx.skills.registerProvider((registration) => new LibrarySkillProvider(
        {
          libraryDir: tree.path('library'),
          providerName: 'skills-manager',
          rank: 450,
          readState: () => state.read(),
          logger: silentLogger,
        },
        registration,
      ))
      ctx.skills.registerProvider(() => new FixedProvider([{
        name: 'shared',
        description: 'Project copy.',
        invocation: { modelInvocable: true, userInvocable: true },
        provider: 'fixed',
        source: 'project-dsh',
        rank: 100,
        locator: null,
      }]))

      const [winner] = await ctx.skills.list()
      expect(winner?.provider).toBe('fixed')
    } finally {
      tree.cleanup()
    }
  })
})
