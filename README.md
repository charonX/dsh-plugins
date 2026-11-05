# @charonx/dsh-immersive-translate

Immersive bilingual translation for DeepSeek Harness, driven by the model this
Harness already serves: a frame-wide floating control, whole-page bilingual
rendering, and a dictionary pane beside the conversation.

## Status

Milestone 1 is implemented: the floating control, the Host translation engine
(agent call with thinking disabled when the route allows it), and the settings
page. Whole-page bilingual rendering (M2) and the dictionary pane (M3) are next.

| Area | State |
|---|---|
| Frame-wide floating control with a manual batch box | done |
| Host engine: `ctx.llm.prepareCall` + batch prompt + JSON contract | done |
| Model catalog read from the Harness providers, thinking-capability flags | done |
| Settings page: destination language, follow/default or explicit model | done |
| Session-log pointer `plugin:immersive-translate/batch` + payload archive | done |
| Whole-page bilingual rendering (`data-dsh-tr` + CSS `::after`) | M2 |
| Dictionary pane in the right sidebar | M3 |
| Translation cache and glossary | M4 |

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
one) are written by the settings page into `statePath`, never into the profile.

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
  more slowly, and its reasoning tokens share the request's output ceiling.

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

With that in place the settings page lists `off, low` under the engine and the
floating panel states that thinking is turned off. The settings page always
prints the adapter-reported list, so this is checkable without reading the
adapter source.

The reverse is the part no configuration read can answer: a route that offers
`off` can still think, because on some protocols `off` is expressed by omitting
a parameter and the gateway then applies its own default. Every translate
response therefore carries `reasoned`, whether any reasoning output accompanied
the batch, and the panel reports it: "no reasoning output" proves the setting
took effect, "reasoned for this batch" proves it did not.
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

## Session trace

Each translated batch writes one `plugin:immersive-translate/batch` record to the
Session log: destination language, provider, model, recipe, content key, and item
count. The exact source and result live in `batchDir/<contentKey>.json`, so the
request stays reconstructable without inflating the log. Recording is best
effort: an inactive Session leaves the translation itself unaffected.

## HTTP surface

| Route | Method | Purpose |
|---|---|---|
| `/api/state` | GET | Preferences, provider catalog, effective selection, limits |
| `/api/prefs` | POST | Persist a preference patch |
| `/api/translate` | POST | Translate one batch (`items`, optional `targetLanguage`, `sessionId`) |

Mutating requests apply the Host trust rules (loopback or declared hosts, no
cross-site fetch, matching `Origin`).

## Known limitations

- **Only bilingual mode exists.** There is no translation-only mode, so nothing
  removes original text; M2 renders translations through a block attribute and a
  CSS `::after`, which leaves React's subtree untouched.
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
