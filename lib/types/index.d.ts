/**
 * Skills manager plugin entry: registers the library-backed skill provider and
 * the HTTP routes the Web Client uses.
 *
 * @module dsh-skills-manager
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Config as ConfigShape } from './config.js';
export { Config } from './config.js';
export type { Config as SkillsManagerConfig } from './config.js';
export { LibrarySkillProvider, MANAGED_SKILL_SOURCE } from './provider.js';
export { StateStore } from './state.js';
export { buildSnapshot } from './view.js';
export declare const name = "skills-manager";
export declare const inject: string[];
/**
 * Register the manager on the Harness context.
 * @param ctx - plugin context; `ctx.skills` must be available.
 * @param config - validated plugin configuration.
 */
export declare function apply(ctx: Context, config?: ConfigShape): void;
