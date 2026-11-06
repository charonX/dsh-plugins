/**
 * Apply manager state to a library scan, producing the observation the Web
 * Client renders.
 *
 * @module dsh-skills-manager/view
 */
import type { ScannedSource } from './library.js';
import type { LibrarySnapshot, UpdateCheck } from './shared/api.js';
import { type StateFile } from './state.js';
/**
 * Compose the library snapshot.
 * @param libraryDir - absolute library root.
 * @param statePath - absolute state file path.
 * @param sources - scanned sources.
 * @param state - current manager state.
 * @returns the snapshot served by `GET /api/library`.
 */
export declare function buildSnapshot(libraryDir: string, statePath: string, sources: readonly ScannedSource[], state: StateFile, updates?: Readonly<Record<string, UpdateCheck>>): LibrarySnapshot;
