# Design decisions

Accepted decisions for this plugin, with the reasoning that constrains the next
milestones. Update this file when a decision changes.

## Rendering: bilingual only, DOM-attribute channel

Only bilingual output is built. Translations render through a per-block
attribute (`data-dsh-tr`) plus a plugin-injected stylesheet
(`[data-dsh-tr]::after { content: attr(data-dsh-tr); display: block }`).

Why: it adds no nodes to React's subtree, so re-renders cannot drop or fight the
translation, and unloading is "remove the attributes and the stylesheet".
Translation-only mode would require wrapping original text nodes, which is the
only part of the design that can collide with React reconciliation; it is
deliberately not built.

Blocks are translated at block granularity (the nearest `p/li/h1..h6/td/dd/
blockquote` ancestor), one request per group of blocks, because sentence-level
requests lose word order across inline markup.

## Scope: Harness surfaces only

Whole-page translation covers what the plugin can reach in the same document:
conversation, settings, plugin pages, the plugin market. It never touches
`pre/ code/ textarea/ input/ [contenteditable]` or its own subtrees
(`[data-dsh-translate-ui]`).

The sidebar Browser is excluded. In Web it is a cross-origin iframe, which the
browser security model keeps unreadable. On Desktop it is an Electron
`<webview>` guest whose lease policy (`apps/desktop/src/browser-guests.ts`)
deliberately denies plugins a script channel; using `executeJavaScript` there
would bypass that contract and is out of scope.

## Engine: the Host's own model, thinking off when possible

Translation runs as an auxiliary `ctx.llm` request, not an agent turn: no
conversation history, fixed system prompt, one JSON batch in and out.
`reasoningEffort: 'off'` is requested only when the resolved route advertises
that effort, because the runtime rejects an unsupported effort and rejects any
effort on a route without reasoning metadata.

Reasoning output is tolerated rather than refused: a hybrid-thinking route (for
example a Qwen3 model behind an OpenAI-compatible gateway) may emit a reasoning
block before its text even when no effort was requested, and on pi-ai routes
selecting `off` does not guarantee disabled reasoning when the protocol carries
it by omitting the field. The engine ignores the reasoning block, requires at
least one non-empty text block, and refuses tool calls; disabling thinking for
good is a provider-configuration decision (`reasoningEfforts: false` declares a
non-reasoning model), not something this plugin forces.

Model resolution order: explicit preference, then the bound Session's
`modelSelection` projection, then `ctx.agentDefaultModel.currentSelection()`.

## Session trace: lightweight pointer plus archive

The Session log receives `plugin:immersive-translate/batch` with destination
language, provider, model, recipe, content key, and item count. The exact source
and result live in a content-addressed archive under the plugin's data
directory. This keeps "the request is reconstructable" true without writing
whole pages into the log.

## Settings: select, never configure providers

The plugin's settings page selects a destination language and a model. Providers,
credentials, and catalog edits stay in the Harness model settings. The page
states that in copy instead of navigating there: the settings shell exposes
`openSettings` only to launcher slots and `openSection` only to onboarding
steps, so a third-party section has no supported jump.

## Roadmap

- M2: whole-page bilingual rendering (viewport-first scanning, batching,
  incremental `MutationObserver` top-up, one-click restore).
- M3: dictionary pane (`sidebarRightTabs` kind plus `sidebar.right.pane.tab`),
  selection menu entry, global shortcut, glossary.
- M4: translation cache keyed by the same content hash, glossary injection,
  cost guards per page.
