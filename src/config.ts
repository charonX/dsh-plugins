/**
 * Plugin configuration schema.
 *
 * @module dsh-skills-manager/config
 */

import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'

/** Skill manager configuration accepted from `cordis.yml`. */
export interface Config {
  /** Managed library root; defaults to `<dshHome>/skills-manager/library`. */
  libraryDir?: string
  /** Manager state file; defaults to `<dshHome>/skills-manager/manager-state.json`. */
  statePath?: string
  /** Per-project link record; defaults to `<dshHome>/skills-manager/links.json`. */
  linksPath?: string
  /** Last update-check record; defaults to `<dshHome>/skills-manager/updates.json`. */
  updatesPath?: string
  /** Provider name registered on `ctx.skills`; defaults to `skills-manager`. */
  providerName?: string
  /** Provider precedence rank; lower wins against other providers. */
  rank?: number
  /** HTTP prefix the routes and the Web Client payload use. */
  routePrefix?: string
  /** Whether `file://` git identifiers are accepted for local repositories. */
  allowFileProtocol?: boolean
}

/** Validated configuration schema. */
export const Config: Schema<Config> = z.object({
  libraryDir: z.string(),
  statePath: z.string(),
  linksPath: z.string(),
  updatesPath: z.string(),
  providerName: z.string().min(1).default('skills-manager'),
  rank: z.number().default(450),
  routePrefix: z.string().default('/dsh-skills-manager'),
  allowFileProtocol: z.boolean().default(true),
})
