/**
 * HTTP surface of the skills manager: one `prefix` route registered on the
 * host web server, answering the Web Client's JSON requests.
 *
 * Mutating requests are checked against the host trust rules (loopback or a
 * declared `trustedHosts` authority, no cross-site fetch, matching `Origin`)
 * because they install code-bearing directories into the user's library.
 *
 * @module dsh-skills-manager/http
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { JobRegistry } from './jobs.js';
import type { LinkManager } from './links.js';
import { type ImportStore } from './imports.js';
import { type UpdateStore } from './updates.js';
import { type WarnLogger } from './library.js';
import type { WorkspaceOptionView } from './shared/api.js';
import type { StateStore } from './state.js';
/** Host services the routes read, injected through live getters. */
export interface HttpDeps {
    /** Absolute route prefix, without a trailing slash. */
    readonly prefix: string;
    /** Absolute library root. */
    readonly libraryDir: string;
    /** Absolute state file path. */
    readonly statePath: string;
    /** Whether `file://` git identifiers are accepted. */
    readonly allowFileProtocol: boolean;
    /** Manager state store. */
    readonly state: StateStore;
    /** Job registry. */
    readonly jobs: JobRegistry;
    /** Project symlink distribution manager. */
    readonly links: LinkManager;
    /** Persisted update-check results. */
    readonly updates: UpdateStore;
    /** Import provenance. */
    readonly imports: ImportStore;
    /** Extra global skill roots offered by the import scanner. */
    readonly scanExtraRoots: readonly string[];
    /** DSH workspaces offered as link targets. */
    readonly listWorkspaces: () => readonly WorkspaceOptionView[];
    /** Plugin logger. */
    readonly logger: WarnLogger;
    /**
     * Read the host connection service for declared trusted authorities.
     * @returns the current trusted host list, or undefined without the service.
     */
    readonly trustedHosts: () => readonly string[] | undefined;
    /** Invalidate the skill catalog after a successful mutation. */
    readonly onLibraryChanged: () => void;
}
/**
 * Create the request handler registered on `ctx.webServer`.
 * @param deps - resolved host dependencies.
 * @returns the route handler.
 */
export declare function createRequestHandler(deps: HttpDeps): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
/**
 * Apply the host's browser-trust rules to a mutating request.
 * @param request - incoming request.
 * @param trustedHosts - authorities the deployment declared, if any.
 * @returns whether the request may mutate manager state.
 */
export declare function isTrustedRequest(request: IncomingMessage, trustedHosts: readonly string[] | undefined): boolean;
