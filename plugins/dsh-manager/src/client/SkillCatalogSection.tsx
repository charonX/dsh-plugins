/** Read-only Skill catalog view across workspace roots and host `ctx.skills` with one-click Playbook import. */
import { useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DiscoveredSkill } from '../flow/flow-ir.ts'
import css from './TeamPage.module.css'

export interface SkillCatalogSectionProps extends PropsLocale<'dshManager'> {
  readonly skills: readonly DiscoveredSkill[]
  readonly busy?: boolean
  readonly onRefresh: () => Promise<void>
  readonly onCompileSkill: (skillName: string) => Promise<void>
}

export function SkillCatalogSection({ skills, busy, onRefresh, onCompileSkill, t }: SkillCatalogSectionProps) {
  const [query, setQuery] = useState('')
  const [compiling, setCompiling] = useState<string | undefined>()
  const needle = query.trim().toLowerCase()
  const filtered = needle === ''
    ? skills
    : skills.filter(skill =>
        skill.name.toLowerCase().includes(needle)
        || skill.description.toLowerCase().includes(needle)
        || skill.path.toLowerCase().includes(needle))

  const compile = async (name: string): Promise<void> => {
    setCompiling(name)
    try {
      await onCompileSkill(name)
    } finally {
      setCompiling(undefined)
    }
  }

  return (
    <section id="dsh-team-skills" className={css.workbenchRoot} aria-label={t('team.view.skills')}>
      <div className={css.workbenchHeader}>
        <div className={css.archTitleGroup}>
          <input
            type="search"
            className={css.input}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t('skills.searchPlaceholder')}
            aria-label={t('skills.searchPlaceholder')}
          />
          <span className={css.archSubtitle}>{t('skills.count', { count: filtered.length })}</span>
        </div>
        <Button variant="outline" size="sm" disabled={busy === true} onClick={() => { void onRefresh() }}>
          {t('skills.refresh')}
        </Button>
      </div>

      {filtered.length === 0
        ? <p className={css.empty}>{t('skills.empty')}</p>
        : (
          <div className={css.skillGrid}>
            {filtered.map(skill => (
              <article key={`${skill.source ?? 'workspace'}-${skill.name}`} className={css.skillCard}>
                <div className={css.skillCardHead}>
                  <strong className={css.skillName}>{skill.name}</strong>
                  <Tag tone={skill.source === 'host' ? 'info' : 'neutral'}>
                    {t(skill.source === 'host' ? 'skills.source.host' : 'skills.source.workspace')}
                  </Tag>
                </div>
                <p className={css.skillDesc}>{skill.description !== '' ? skill.description : t('skills.noDescription')}</p>
                <code className={css.skillPath} title={skill.path}>{skill.path}</code>
                <div className={css.skillActions}>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy === true || compiling !== undefined}
                    onClick={() => { void compile(skill.name) }}
                  >
                    {compiling === skill.name ? t('skills.compiling') : t('skills.compileAsFlow')}
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
    </section>
  )
}
