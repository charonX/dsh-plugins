# @charonx/dsh-immersive-translate

Immersive bilingual translation for DeepSeek Harness, driven by the model this
Harness already serves: a frame-wide floating control, whole-page bilingual
rendering, and a dictionary pane beside the conversation.

## Status

M1 and M2 are implemented, plus the parts of M3/M4 that do not need a sidebar
pane: the floating control, the Host engine (auxiliary call, thinking off when
the route allows it), the settings page, whole-page bilingual rendering with
incremental top-up and one-click restore, the conversation selection action, and
a content-addressed replay cache.

| Area | State |
|---|---|
| Frame-wide floating control with a manual batch box (Enter translates) | done |
| Host engine: `ctx.llm.prepareCall` + batch prompt + JSON contract | done |
| Earliest echo detection: a copied source text is retried once | done |
| Settings page: destination language, model, submit key | done |
| Session-log pointer `plugin:immersive-translate/batch` + payload archive | done |
| Whole-page bilingual rendering (`data-dsh-tr` + CSS `::after`) | done |
| Incremental top-up for streaming and route changes, one-click restore | done |
| Conversation selection action (`uiConversation` text interaction) | done |
| Replay cache keyed by recipe + language + route + text | done |
| Dictionary pane in the right sidebar | M3 |
| Glossary injection and per-page cost guards | M4 |

## Install

```sh
dsh plugin --profile dev add ./dsh-immersive-translate
dsh --profile dev
```

The bundle patch inserts one row (`id: immersive-translate`); configuration from
a profile patch replaces the whole `config` block, not individual keys.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `routePrefix` | `/dsh-immersive-translate` | HTTP prefix for the plugin routes |
| `statePath` | `<dshHome>/immersive-translate/prefs.json` | Reader preferences |
| `batchDir` | `<dshHome>/immersive-translate/batches` | Content-addressed batch archive |
| `targetLanguage` | `zh-CN` | Default destination language |
| `maxItemsPerBatch` | `20` | Text units per model request |
| `maxCharsPerItem` | `4000` | Longest accepted single text unit |
| `maxOutputTokens` | `8192` | Output ceiling per request; reasoning tokens count toward it |
| `requestTimeoutMs` | `120000` | Whole-request deadline |

Reader preferences (destination language, following the default model or naming
one, and the submit key of the translate box) are written by the settings page
into `statePath`, never into the profile. They are stored as
`{ targetLanguage, followDefaultModel, submitKey, provider?, model? }`; any other
value in the file is dropped on read, so an older file keeps working.

Providers and credentials are **not** configured here: this plugin only lists what
`ctx.llm` already serves, and its settings page offers a selector plus a pointer
to the Harness model settings.

## Engine behaviour

- The model is resolved in three steps: an explicit preference, then the Session's
  recorded `modelSelection` projection (when the caller passes a session id), then
  `ctx.agentDefaultModel.currentSelection()`.
- Thinking is turned off with a `ConfigureCall` that only selects the `off` effort
  when the resolved route advertises it. A route without `off`, or without any
  reasoning metadata, receives no effort at all — the runtime rejects an
  unsupported one.
- A hybrid-thinking route may still reason before answering. The reasoning block
  is ignored and its text block is used, so such a route translates correctly but
  more slowly, and its reasoning tokens share the request's output ceiling. The
  panel says so only after a batch that actually reasoned; a route that did not
  reason gets no note, because a static warning about a cost the reader cannot
  change is noise.
- The instruction names the destination language (`简体中文 (zh-CN)`) instead of
  passing the bare tag, and every answer that copies its source text verbatim is
  retried once with a stricter instruction. A small route does occasionally echo
  the input back, and an echo is indistinguishable from a broken engine in the
  panel.

### How "thinking can be turned off" is decided

The plugin reads one fact only: the `reasoning.efforts` list the adapter reports
for the resolved route, and whether it contains `off`. It never probes a
gateway. When `off` is absent it sends no effort at all, because the runtime
rejects an unsupported effort and rejects any effort on a route that reports no
reasoning metadata.

For a `llm-pi-ai` route that list comes from the model's `thinkingLevelMap`,
which is built from the provider configuration:

- `reasoningEfforts` declared → the declared levels become the offered list, and
  every undeclared level is pinned to unsupported;
- `reasoningEfforts: false` → a non-reasoning model;
- neither, and no installed catalog entry for that model id → the adapter
  reports **no reasoning metadata**, so no effort can be selected and the
  gateway's own default decides whether to think.

Disabling thinking therefore has to be spelled the way the gateway understands
it, which is a provider-configuration concern, not a plugin one. A gateway that
expresses "off" as a positive flag needs both a compat format and a declared
`off` level:

```yaml
- id: llm-pi-ai
  config:
    providers:
      siliconflow:
        api: openai-completions
        baseURL: https://api.siliconflow.cn/v1
        compat:
          thinkingFormat: qwen        # emits enable_thinking for this gateway
        models:
          - id: Qwen/Qwen3-8B
            reasoningEfforts:
              off:                    # off travels as the absence of an effort
              low: low                # at least one thinking level must be declared
```

A gateway that only knows `system`/`user`/`assistant`/`tool` also needs the role
compat switch, because declaring reasoning levels makes pi-ai treat the model as
reasoning-capable and switch system messages to `developer`:

```yaml
        compat:
          supportsDeveloperRole: false
```

With that in place the route advertises `off, low`, so the plugin selects `off`
for translation. This is a provider-configuration decision: the panel does not
report the effort list, and no UI copy depends on it.

How to tell it took effect: a route that offers `off` can still think, because
on some protocols `off` is expressed by omitting a parameter and the gateway
then applies its own default. Every translate response therefore carries
`reasoned`, whether any reasoning output accompanied the batch, and the panel
prints one short note for the batches where it is true.
- Every batch is one auxiliary request outside the agent loop: one leading user
  message carrying the instruction plus the JSON payload, and no conversation
  history. The instruction deliberately does not use `GenerateOptions.system`,
  because an OpenAI-style adapter maps a system message to the provider-specific
  `developer` role when the model is declared reasoning-capable, and gateways
  outside that dialect reject it (SiliconFlow answers `Input tag 'developer' ...
  does not match`). See the provider note below if a route still needs it.
- The reply must be `{"items":[{"id","text"}]}` with one entry per input, in
  request order; a missing id, no text block, a tool call, or a non-`stop` finish
  is refused rather than partially applied.

## Whole-page translation

The panel's `翻译此页` button translates the page bilingual-style: translations
render under each block through `[data-dsh-tr]::after`, so the original text stays
in place and no React subtree is touched. `还原原文` removes every attribute and
the injected stylesheet.

- **Blocks** are *leaf blocks*: elements that lay out as a block, carry text, and
  have no block-level descendant carrying text. This is deliberately not a tag
  list, so a `div`-built card body is translated while `<li><p>…</p></li>` still
  translates once.
- **Never translated**: `pre`, `code`, `textarea`, `input`, `select`, `option`,
  `script`, `style`, `noscript`, `[contenteditable]`, `[hidden]`, anything hidden
  by an ancestor (`display:none`, `visibility:hidden`), and this plugin's own
  surface (`[data-dsh-translate-ui]`). A wrapper that contains a `pre` sends only
  its own prose, never the literal source.
- **Identical strings are sent once** and their answer is applied to every block
  that carries them, which is most of the saving on a settings page. Blocks above
  `maxCharsPerItem` are skipped, never truncated.
- **Batches are serialized**: one request at a time, so a slow route does not open
  a burst of streams. Progress is shown as `翻译中 n/m`.
- **Top-up**: a `MutationObserver` re-scans 300 ms after a burst of DOM changes,
  which is how a streaming answer or a route change gets translated. A block whose
  text changed since it was translated drops its stale attribute and is requested
  again; unchanged blocks are not re-requested.
- **Failure** stops the sweep and leaves what was already applied; the button
  reports the failure and pressing it again continues with the untranslated blocks.
  `还原原文` is always the way back to the untouched page.

## Selection translation

Selecting text in a conversation offers `翻译选中` beside the Host's own selection
actions, rendered through the keyed `conversation.chat.text-interaction` seat. The
result appears in a small card. The action registers only while the
`uiConversation` service exists, so a runtime without it still loads the plugin.

## Testing

```sh
pnpm typecheck        # host, browser, and test projects
pnpm test             # Vitest: engine, HTTP, preferences, cache, prompts, batching, DOM scanner (jsdom)
pnpm build
./check-plugins-against-harness.sh dsh-immersive-translate   # from the workspace root

# Browser end-to-end: start the dev server, then run the suite against the URL it prints.
(cd ../deepseek-harness && pnpm dsh web --port 3099 --no-open)   # prints http://127.0.0.1:3099/?token=…
DSH_E2E_URL="http://127.0.0.1:3099/?token=…" pnpm e2e
```

`pnpm e2e` drives a real page with Playwright (installed Chrome) and stubs only
the `/api/translate` route, so DOM scanning, batching, painting, top-up, and
restore run for real while the model is never called. Without `DSH_E2E_URL` the
suite targets `http://127.0.0.1:3080` and fails on the server's 401, which is the
hint that the token URL is missing.

## Panel keys

| Mode | Translate | Line break |
|---|---|---|
| `Enter` (default) | `Enter`, and `Ctrl/Cmd+Enter` | `Shift+Enter` |
| `Ctrl/Cmd+Enter` | `Ctrl+Enter` or `Cmd+Enter` | `Enter`, `Shift+Enter` |

The mode is a reader preference (`submitKey`, chosen in the plugin's settings
section). Both modes are applied to the box's own `keydown`, not registered as a
shortcut, so nothing fires while the reader types in the conversation, the
settings page, or another plugin's form. The rule also ignores Enter while an
IME composition is open (Enter confirms the candidate), ignores auto-repeat, and
does not submit while a request from the same box is still running.

## Replay cache

Before calling the model, `/api/translate` looks the batch up in the archive by
its content key: recipe (prompt version), destination language, provider, model,
and the source text. A hit answers from disk and costs nothing; it still writes
the Session pointer, with `cached: true` and zero attempts.

An answer that copied its source text even after the retry is stored with
`cacheable: false` and is never replayed, because an echo cached as a translation
would be served forever. There is no TTL or eviction yet (M4), so the archive grows
with distinct texts.

## Session trace

Each translated batch writes one `plugin:immersive-translate/batch` record to the
Session log: destination language, provider, model, recipe, content key, item
count, plus `reasoned`, `attempts`, and `durationMs`. The exact source and result
live in `batchDir/<contentKey>.json`, together with the same three facts, so the
request stays reconstructable without inflating the log. Recording is best
effort: an inactive Session leaves the translation itself unaffected.

`attempts` (2 means a copied source text forced a retry) and `durationMs` exist
because "the translation felt slow" is otherwise unanswerable after the fact: the
panel is unmounted, the reasoning note only covers reasoning output, and the
button's spin time includes the network. The archive answers it instead.

## HTTP surface

| Route | Method | Purpose |
|---|---|---|
| `/api/state` | GET | Preferences, provider catalog, effective selection, limits |
| `/api/prefs` | POST | Persist a preference patch (`targetLanguage`, `followDefaultModel`, `submitKey`, `provider`, `model`) |
| `/api/translate` | POST | Translate one batch (`items`, optional `targetLanguage`, `sessionId`) |

Mutating requests apply the Host trust rules (loopback or declared hosts, no
cross-site fetch, matching `Origin`).

## Known limitations

- **Only bilingual mode exists.** There is no translation-only mode, so nothing
  removes original text; translations render through a block attribute and a CSS
  `::after`, which leaves React's subtree untouched.
- **No dictionary pane or glossary yet.** The right-sidebar pane (M3) and prompt
  glossary injection (M4) are still open.
- **No per-page cost guard yet.** A sweep spends one request per batch; there is no
  character budget or confirmation for a large page.
- **The cache never expires.** The archive is content-addressed and append-only; a
  TTL or size-based eviction is part of M4.
- **The floating control cannot see a Session.** `shell.overlay` is root-scoped and
  the Client keeps no global current Session, so today the engine uses the Host
  default model. Session-level following arrives with the session-scoped
  dictionary pane.
- **No jump to the model settings page.** The settings shell exposes `openSettings`
  to launcher slots only and `openSection` to onboarding steps, so a third-party
  section cannot navigate to another section; the page states where providers are
  configured instead.
- **The sidebar Browser is out of scope.** In Web it is a cross-origin iframe and
  unreadable; the Desktop `<webview>` guest is deliberately closed to plugins.
- Translation calls spend model quota and send page text to the model; every
  surface must stay behind an explicit user action.
