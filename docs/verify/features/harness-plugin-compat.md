# Harness 与插件兼容性门禁

## Sub-features

- `deepseek-harness` 构建产物与源码一致性
- 通过 `link:` 将所有 `@deepseek-ai/*` 映射到真实本地 checkout 做类型检查
- 全插件 client bundle 构建与 `vitest` 单元测试

## How to get to it (user POV)

在 `repos/dsh` 根目录通过命令行运行官方对齐脚本与目标插件测试（不可仅运行单仓 `pnpm typecheck`，否则 `skipLibCheck` 会掩盖宿主类型不匹配）。

## Driving it

```sh
./docs/verify/scripts/doctor.sh
./check-plugins-against-harness.sh
```

针对特定插件快速回归时可传目录参数（如 `./check-plugins-against-harness.sh --skip-build plugins/dsh-manager plugins/external-agents`）。

## Gotchas

- `deepseek-harness` 源码修改后必须先在 `deepseek-harness/` 执行 `pnpm run build`，否则脚本会拒绝在过期产物上给结论。
- 尚未实现 `src/client/index.tsx` 的骨架插件（如 `media-station`）在 summary 中显示 `WIP` 属正常预期，其余有效插件必须全部 `PASS`。
