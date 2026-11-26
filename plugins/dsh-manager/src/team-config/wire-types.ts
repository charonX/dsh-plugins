/**
 * Wire-level schemas for team-config YAML import.
 */
import { z as zod } from 'zod'

export const teamConfigImportYamlInputSchema = zod.object({
  yaml: zod.string(),
})

export type TeamConfigImportYamlInput = zod.infer<typeof teamConfigImportYamlInputSchema>
