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

Blocks are translated at block granularity, one request per group of blocks,
because sentence-level requests lose word order across inline markup.

What counts as a block is a **leaf block**, not a tag list: an element that lays
out as a block (`display` neither `inline*` nor `none`), carries text, and has no
block-level descendant carrying text. The first implementation used a tag
whitelist (`p`, `li`, headings, cells, ...) and was wrong in the field: the skills
page is built from `div` cards, so a real page translated one paragraph and then
reported that the page had nothing to translate. A display-based leaf rule finds
the same paragraph in a `div` card body, still translates `<li><p>...</p></li>`
once, and needs no maintenance when a surface changes tags.

Text is computed bottom-up with skipped subtrees contributing the empty string, so
a `div` that wraps a `pre` block sends only its own prose: literal source never
reaches the model. Hidden content is skipped by walking ancestors, because
`display` is not inherited.

Implemented in three pieces, split by what can be tested without a browser:

- `shared/page.ts` (pure, unit-tested): block text normalization, de-duplication
  of identical strings, request ids, batching, and the request-to-block map.
  De-duplication matters more than it looks: a settings page repeats `Save`,
  `Cancel`, and `Model` a dozen times, and only distinct strings are paid for.
- `client/pageDom.ts` (thin adapter): walks the document, decides ownership
  between nested blocks, and writes the two attributes. Rules deliberately do not
  live here. It is covered by jsdom tests (`tests/pageDom.spec.ts`) that assert
  what becomes one block on real markup: div cards, inline markup, nested blocks,
  `pre`/`code`, hidden subtrees, and the plugin's own surface.
- `client/pageTranslator.ts` (orchestrator): one instance per page, owned by the
  browser half rather than the panel, so closing the panel keeps the page
  translated. It sweeps, sends batches serially, paints each batch as it lands,
  and re-scans 300ms after a burst of mutations. An idle top-up keeps the counters
  it already had, so the empty-page notice only ever describes the first sweep of
  a page with no blocks.

Staleness is per block: the source used for an answer is stored beside it
(`data-dsh-tr-src`). A re-render that changes the text drops both attributes and
the block is requested again; an unchanged block is skipped. Without that, a
streaming answer would either keep an out-of-date translation or be re-requested
on every render.

The plugin's own surface carries `data-dsh-translate-ui` so a sweep never
translates the panel that started it, and the stylesheet uses
`color: var(--dsw-alias-label-secondary)` so light and dark stay aligned and the
original keeps primacy.

## Scope: Harness surfaces only

Whole-page translation covers what the plugin can reach in the same document:
conversation, settings, plugin pages, the plugin market. It never touches
`pre/ code/ textarea/ input/ select/ option/ script/ style/ noscript`,
`[contenteditable]`, `[hidden]`, content hidden by an ancestor, or its own
subtrees (`[data-dsh-translate-ui]`).

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

The decision input is the adapter's report, never a probe: the plugin offers
`off` exactly when the resolved route's `reasoning.efforts` contains it. A
`llm-pi-ai` route that declares no `reasoningEfforts` and has no installed
catalog entry reports no reasoning metadata at all, because pi-ai will not offer
`off` where `off` would only mean "omit the parameter" and leave the gateway
default thinking. Turning thinking off for such a gateway is a provider
configuration: declare a `compat.thinkingFormat` plus an `off` level, and the
adapter then sends the gateway's own "off" spelling.

Reasoning output is tolerated rather than refused: a hybrid-thinking route (for
example a Qwen3 model behind an OpenAI-compatible gateway) may emit a reasoning
block before its text even when no effort was requested, and on pi-ai routes
selecting `off` does not guarantee disabled reasoning when the protocol carries
it by omitting the field. The engine ignores the reasoning block, requires at
least one non-empty text block, and refuses tool calls; disabling thinking for
good is a provider-configuration decision (`reasoningEfforts: false` declares a
non-reasoning model), not something this plugin forces.

The response carries `reasoned` so the panel can say "this batch reasoned, so it
was slower" - but only for batches where it is true. Earlier drafts printed the
adapter's effort list, a "thinking is off" confirmation, and a "no reasoning
output" line on every batch; that is three captions about an internal detail the
reader cannot act on, and it buried the two fields the panel exists for. The
diagnostics moved to this document and to the provider configuration, and the
panel keeps only what the reader acts on: the text, the button, the answer.

## Prompt: name the language, never accept an echo

The instruction names the destination language (`简体中文 (zh-CN)`) instead of
passing the bare tag, and states that the source text is never an answer. A
small route given only `"targetLanguage":"zh-CN"` occasionally answers with the
source text unchanged - observed on SiliconFlow `Qwen/Qwen3-8B` for the single
word `computer` while `computert` translated fine - which the panel cannot
distinguish from a broken engine.

An answer that copies any source text verbatim is retried once with a stricter
instruction, and the retry's answer is final: repeating it would only add
latency for a route that cannot do better. Legitimate copies (`DSH`, a file
path, a product name) cost one extra request, which is cheaper than presenting
a page of untranslated text as a translation. `RECIPE` carries the prompt
version, so an archived batch records which instruction produced it.

Model resolution order: explicit preference, then the bound Session's
`modelSelection` projection, then `ctx.agentDefaultModel.currentSelection()`.

## Requests stay off the provider's role dialect

The batch instruction rides the leading user message instead of
`GenerateOptions.system`. An OpenAI-compatible adapter maps a system message to
the `developer` role once the model is declared reasoning-capable, and a gateway
that only implements `system`/`user`/`assistant`/`tool` rejects the whole request
with a 400. An auxiliary request buys nothing from that role, so it does not ask
for it.

## Shortcuts stay inside the box

The rule lives in the box's own `keydown` (`src/shared/keys.ts`, unit-tested
without a DOM) rather than in the Host shortcut service: a frame-wide binding
would fire while the reader types a prompt in the conversation, edits the
settings page, or uses another plugin's form. Translation is a local action on
one field, so its key must not be global.

The key itself is a reader preference, because the right one depends on habit and
input method:

| `submitKey` | Translate | Line break |
|---|---|---|
| `enter` (default) | Enter, and Ctrl/Cmd+Enter | Shift+Enter |
| `mod-enter` | Ctrl+Enter or Cmd+Enter | Enter, Shift+Enter |

The mode is validated on read (`submitKeyOf` keeps only known values), so a
hand-edited preference file or an old file without the field cannot break the
box. Both modes use the same guard, so switching the key never changes the scope:
the predicate is only ever called from that one textarea.

The predicate ignores Enter while an IME composition is open, because Enter
confirms a Japanese/Chinese candidate first - submitting there would translate a
half-composed word. `keyCode === 229` covers the engines that still signal
composition that way. Auto-repeat is ignored, and the box does not submit while
its own request is still running.

## Replay: the archive is the cache

`/api/translate` reads the archive by content key before calling the model, so a
repeated batch (a re-opened page, a re-rendered route, the same `Save` label)
costs nothing. The key includes the recipe, because the answer depends on the
prompt: keying on text plus route alone would serve a translation produced by an
older instruction after the prompt changes.

Cacheability is a property of the answer, not of the request: an answer that still
copies its source text after the retry is stored with `cacheable: false` and never
replayed, since an echo cached as a translation would be served forever. Old
payloads without the flag are treated as misses, which also covers the archive
written before the flag existed.

A replay still writes the Session pointer, with `cached: true` and zero attempts,
so the Session log says where a page's translations came from. There is no TTL or
eviction yet; the archive grows with distinct texts, not with requests.

## Session trace: lightweight pointer plus archive

The Session log receives `plugin:immersive-translate/batch` with destination
language, provider, model, recipe, content key, item count, and three latency
facts: `reasoned` (did the route think), `attempts` (2 means a copied source
text forced a retry), and `durationMs`. The exact source and result live in a
content-addressed archive under the plugin's data directory with the same three
facts. This keeps "the request is reconstructable" true without writing whole
pages into the log.

The latency facts are recorded because the alternative is guessing: a slow
batch is either reasoning, a retry, or gateway latency, and none of it is
observable from the panel once it has unmounted. A real report - "that took 6-7
seconds, was it thinking again?" - could not be answered from the archive that
existed at the time, which is what this field set fixes.

## Settings: select, never configure providers

The plugin's settings page selects a destination language and a model. Providers,
credentials, and catalog edits stay in the Harness model settings. The page
states that in copy instead of navigating there: the settings shell exposes
`openSettings` only to launcher slots and `openSection` only to onboarding
steps, so a third-party section has no supported jump.

## Selection action: the conversation text interaction

The conversation selection action is registered through
`uiConversation.interactions` and rendered by the keyed
`conversation.chat.text-interaction` seat, with the interaction id doubling as the
slot key. Two consequences worth keeping:

- The action appears beside the Host's own selection actions instead of a floating
  button of this plugin's own invention, and pointer-down is prevented so the
  selection survives the click.
- Registration is wrapped in `ctx.inject(['uiConversation'], ...)`, so a runtime
  without that service still loads the plugin; only the selection entry disappears.

## Testing: unit, DOM, and a browser

Three layers, each for a bug class it can actually catch:

- **Unit (Node)**: engine, HTTP routes, preferences, cache keys, prompt rules,
  batching. No DOM, no network.
- **DOM (jsdom)**: the block scanner. This layer exists because block selection is
  DOM-shaped, and a tag rule looked correct in review while missing every
  `div`-built page. jsdom supplies the UA stylesheet, so the `display` decisions
  are the real ones.
- **Browser (`e2e/`, Playwright)**: a real `dsh web` with only the translate route
  stubbed. The model is never called - no key, no quota, no latency flakiness - so
  the assertions are about what the reader sees: N blocks painted, div cards
  translated once per block, nothing inside `pre`/`code` or the plugin's own panel,
  top-up after new content appears, and restore removing every attribute.

The browser layer is the only one that exercises the panel's own state end to end.
The report that a page was "done" after one block was a scanner bug that unit tests
happily agreed with, because they never looked at a page.

## Roadmap

- M3 remainder: dictionary pane (`sidebarRightTabs` kind plus
  `sidebar.right.pane.tab` and `.title`), which is also where the panel finally
  gets a bound Session id.
- M4 remainder: glossary injection (per-reader or per-workspace is still
  undecided), per-page character budget and confirmation, archive TTL or
  size-based eviction.
- Deferred by decision: translation-only mode, the sidebar Browser, viewport-first
  scanning (a sweep currently walks the whole page; it matters only for very long
  conversations).
