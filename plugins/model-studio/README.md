# @charonx/dsh-model-studio

Model-layer studio for DeepSeek Harness: provider presets, endpoint compatibility
(thinking dialect) editing, probe-and-remember for unknown gateways, and
per-model reasoning defaults — all inside the official Models settings page.

The build specification lives in [docs/SPEC.md](docs/SPEC.md) — read it first: it records the
seams this plugin may use, the compatibility model it implements, and the protocol behind
"off does not actually turn thinking off". The implementation design (what this version
builds, its write contracts, and its known failure surface) is [docs/DESIGN.md](docs/DESIGN.md);
vocabulary is [GLOSSARY.md](GLOSSARY.md).

## Status

One settings page (Settings → Model overrides) and nothing injected into the official
Models page: add a provider from the snapshot preset catalogue, edit a route's
gateway-level compatibility, and override compatibility per model. Probing and dialect
memory are deliberately out of scope for now;
[ADR-0001](docs/adr/0001-no-probe-snapshot-derived-compat.md) records why and what would
bring them back.

## Development

```sh
cd /Users/zhanglei/charon/code/workspace/dsh/dsh-model-studio
pnpm install && pnpm run build     # build before installing into a profile
pnpm typecheck && pnpm test
pnpm run sync:models-dev           # refresh src/data/presets.generated.ts from models.dev
cd .. && ./dev.sh                  # rebuild + hot reload through the official HMR chain
```

Install once with `dsh plugin --profile web add ./dsh-model-studio`; afterwards
`./dev.sh` is enough (no uninstall, no restart).
