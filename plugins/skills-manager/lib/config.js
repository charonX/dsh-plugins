/**
 * Plugin configuration schema.
 *
 * @module dsh-skills-manager/config
 */
import z from '@deepseek-ai/schemastery';
/** Validated configuration schema. */
export const Config = z.object({
    libraryDir: z.string(),
    statePath: z.string(),
    linksPath: z.string(),
    updatesPath: z.string(),
    importsPath: z.string(),
    providerName: z.string().min(1).default('skills-manager'),
    rank: z.number().default(450),
    routePrefix: z.string().default('/dsh-skills-manager'),
    allowFileProtocol: z.boolean().default(true),
    scanSkillDirs: z.array(z.string()).default([]),
});
//# sourceMappingURL=config.js.map