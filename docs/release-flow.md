# 发版工作流（Changesets + PR to `main` + npm OIDC）

本仓库采用 **Changesets + 受保护 `main` 分支 + npm OIDC Trusted Publishing** 的多包独立发版机制，与 [docs/git-flow.md](git-flow.md) 衔接。

## 1. 纳管范围

- **已纳入自动发版**：`@charonx/dsh-manager`、`@charonx/dsh-external-agents`、`@charonx/dsh-skills-manager`、`@charonx/dsh-system-dashboard`。
- **暂不发版（实验性，配置在 `.changeset/config.json` 的 `ignore` 中）**：`@charonx/dsh-immersive-translate`、`@charonx/dsh-model-studio`、`@charonx/dsh-media-station`。

## 2. 日常发版流程

1. **开发与写变更单**：在 `feat-*` 分支开发并通过 `./check-plugins-against-harness.sh <plugin>` 后，若本次改动需要发版，在仓库根目录运行：
   ```sh
   pnpm changeset
   ```
   选择要升版的插件、SemVer 级别（`patch` / `minor` / `major`）与变更说明，将生成的 `.changeset/<random>.md` 一并提交（若纯文档/测试/内部调整无需发版，可不加 changeset）。
2. **集成测试与 PR 到 `main`**：按 [docs/git-flow.md](git-flow.md) 合入 `test` 实测后，由人工向 `main` 发起 PR（CI 会运行 `.github/workflows/ci.yml` 校验卫生检查与各正式插件的测试及构建）。
3. **自动生成 `Version Packages` PR**：PR 合并进 `main` 后，`.github/workflows/release.yml` 检测到 `.changeset/*.md`，自动创建或更新 **`chore: version packages`** PR（自动提升各变更插件的 `package.json` 版本号、更新各自的 `CHANGELOG.md` 并清理已消费的 changeset 文件）。
4. **合并 `Version Packages` PR 自动发布**：核对版本号与 `CHANGELOG.md` 无误并合并该 PR 后，`release.yml` 自动识别尚未发布到 npm 的版本，逐包执行：
   - `pnpm run test` & `pnpm run build`
   - `npm publish --provenance --access public`（npm OIDC Trusted Publishing）
   - 推送 `<plugin>-v<version>` Git Tag，并创建包含 `.tgz` 的 GitHub Release。

## 3. 紧急单包手动发布兜底

在 GitHub Actions 页面手动触发 `Release Plugin`（`workflow_dispatch`）并选择目标插件目录，或推送 `<plugin>-v<version>` Tag，均可直接走单包 OIDC 发布通道。
