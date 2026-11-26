/**
 * Browser entry of the Dsh Manager bundle: mounts the Remote contribution,
 * then installs the board and connections pages with their sidebar
 * navigation entries through the UI registration, which waits on the
 * mounted namespace.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import remote from '../remote.ts'
import { registerUi, UI_INJECT } from './register.ts'

/**
 * Services the client entry waits on before applying. Only what the page
 * already provides: the namespaced `remote.dshManager` seat comes from this
 * entry's own `$mount` below — declaring it here would park the entry on a
 * service that never exists before apply runs.
 */
export const inject = ['remote', 'slots', 'locale']

/** Mount the Remote contribution, then register the UI on the same fiber. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const unmountRemote = await ctx.remote.$mount(remote)
  // UI effects dispose before the Remote contribution, mirroring the
  // generated-client mount ordering in the harness client packages. The UI
  // fiber's context carries the UI_INJECT grant: the page sources' closures
  // capture THIS context, so their later `ctx.remote.dshManager` reads resolve
  // through the fiber that declares the namespace (reads fired from React
  // callbacks would otherwise be refused by the inject guard).
  const ui = ctx.inject([...UI_INJECT, 'uiWorkspace'], (uiCtx) => registerUi(uiCtx))
  return async () => {
    ui.dispose()
    await unmountRemote()
  }
}
