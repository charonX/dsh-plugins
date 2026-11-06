# Generated data

`presets.generated.ts` is produced by `node scripts/sync-models-dev.ts` from the
models.dev snapshot (MIT) and committed so the runtime never needs the network.
Its header names the source, the license, the snapshot timestamp, and how many
providers were excluded and why; do not edit it by hand.

Rerun the generator when you want a fresher snapshot, then rerun typecheck,
tests, and the build — the catalogue invariants in `tests/catalog.spec.ts` are
what keep a regenerated file honest.
