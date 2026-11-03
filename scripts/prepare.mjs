#!/usr/bin/env node
/**
 * Git installs have no published tarball, so they need the build outputs.
 * Rebuild only when an artifact is missing; `prepack` already builds before
 * packing, and a normal local install keeps an existing build untouched.
 */
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

if (existsSync('lib/index.js') && existsSync('client/client.js')) process.exit(0)
console.log('dsh-skills-manager: build artifacts missing, running build (git install)…')
execFileSync('npm', ['run', 'build'], { stdio: 'inherit' })
