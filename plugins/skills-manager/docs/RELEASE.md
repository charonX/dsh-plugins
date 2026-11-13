# 发版清单

1. 更新版本与日志：

   ```sh
   npm version patch --no-git-tag-version   # 或 minor / major
   ```

   在 `CHANGELOG.md` 顶部补一段对应版本说明。**仓库提交了 `lib/` 与 `client/` 构建产物**：发布前先 `pnpm run build` 并把它们一起提交，这样 Git 安装无需 `prepare`/`allowBuilds`。

2. 跑门禁：

   ```sh
   pnpm run typecheck && pnpm test && pnpm run build && pnpm run smoke:client
   pnpm verify:local
   pnpm verify:profile            # 打包并装进隔离 profile
   ```

3. 提交、打 tag、推送（Monorepo tag 格式为 `skills-manager-vX.Y.Z`）：

   ```sh
   git add plugins/skills-manager
   git commit -m "chore(skills-manager): release vX.Y.Z"
   git tag skills-manager-vX.Y.Z
   git push origin main skills-manager-vX.Y.Z
   ```

4. 发布方式：

   **自动发布（推荐，Trusted Publishing / OIDC）**：在 npm 包设置里（`https://www.npmjs.com/package/@charonx/dsh-skills-manager/access`）绑定 Trusted Publisher：
   - Publisher: GitHub Actions
   - Organization/user: `charonX`
   - Repository: `dsh-plugins`
   - Workflow filename: `release.yml`
   - Environment: 留空

   推送 `skills-manager-vX.Y.Z` tag 后，根目录 `.github/workflows/release.yml` 会自动跑检查、构建、以 OIDC 发布到 npm（`--provenance`），并创建包含 `.tgz` 的 GitHub Release。也可在 GitHub Actions 页面通过 `workflow_dispatch` 手动选择插件触发。

   **手动备用**：`npm login` 后在 `plugins/skills-manager` 目录执行 `npm publish --access public`，并用 `npm pack` + `gh release create skills-manager-vX.Y.Z ...` 创建 Release。

5. 发布后验证两条路径（**必须钉版本**，见第 6 条）：

   ```sh
   dsh plugin --profile smoke-npm add @charonx/dsh-skills-manager@X.Y.Z
   dsh plugin --profile smoke-rel add \
     https://github.com/charonX/dsh-plugins/releases/download/skills-manager-vX.Y.Z/charonx-dsh-skills-manager-X.Y.Z.tgz
   ```

6. 刚发布的版本会被 pnpm 的 `minimumReleaseAge` 暂缓（pnpm 11 默认 24 小时，非 strict 模式下挑上一个成熟版本而不是失败）。因此发布后立即用不带版本号的 `dsh plugin add` 会静默装到上一个版本——这是策略，不是安装出错；DSH 插件管理器会在安装完成页给出「卸载后安装 `name@X.Y.Z`」的提示。精确版本和 tarball / Git spec 不受暂缓影响。

Git 安装（`git+https://…`）直接读取仓库里提交的 `lib/`、`client/`，不需要构建脚本；旧版本（`v0.1.0`）仍会触发 `prepare` 拦截，不要再用它。
