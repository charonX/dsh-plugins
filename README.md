# @charonx/dsh-model-studio

Model-layer studio for DeepSeek Harness: provider presets, endpoint compatibility
(thinking dialect) editing, probe-and-remember for unknown gateways, and
per-model reasoning defaults — all inside the official Models settings page.

The build specification lives in [docs/SPEC.md](docs/SPEC.md). Read it before
changing code: it records the seams this plugin may use, the compatibility model
it implements, and the protocol behind "off does not actually turn thinking off".

## Status

Repository skeleton with a green baseline (typecheck, tests, build). The data
layer and the two Models-page seats are specified but not implemented.

## Development

```sh
cd /Users/zhanglei/charon/code/workspace/dsh/dsh-model-studio
pnpm install && pnpm run build     # build before installing into a profile
pnpm typecheck && pnpm test
cd .. && ./dev.sh                  # rebuild + hot reload through the official HMR chain
```

Install once with `dsh plugin --profile web add ./dsh-model-studio`; afterwards
`./dev.sh` is enough (no uninstall, no restart).
