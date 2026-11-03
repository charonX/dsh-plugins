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

3. 提交、打 tag、推送（tag 名与版本一致）：

   ```sh
   git add -A
   git commit -m "Release vX.Y.Z"
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```

4. 创建 GitHub Release 并附带 tarball（无需构建即可安装）：

   ```sh
   npm pack
   gh release create vX.Y.Z charonx-dsh-skills-manager-X.Y.Z.tgz \
     --title "vX.Y.Z" --notes-file CHANGELOG.md
   ```

5. 发布 npm。两种方式：

   **交互式（当前可用）**：`npm login` 后执行，终端会要求 6 位 OTP：

   ```sh
   npm publish --access public
   # 或非交互：npm publish --access public --otp=123456
   ```

   **Trusted Publishing（推荐，长期）**：在 npm 包设置里添加 Trusted Publisher：
   - Publisher: GitHub Actions
   - Organization/user: `charonX`
   - Repository: `dsh-skills-manager`
   - Workflow filename: `release.yml`
   - Environment: 留空

   之后推送 `v*` tag 即由 `.github/workflows/release.yml` 以 OIDC 发布（`--provenance`），不再需要长期 token。注意：npm 已宣布 **约 2027 年 1 月起 2FA-bypass GAT 不能直接发布**，自动化发布应迁移到 OIDC 或 staged publishing。

6. 发布后验证两条路径：

   ```sh
   dsh plugin --profile smoke-npm add @charonx/dsh-skills-manager
   dsh plugin --profile smoke-rel add \
     https://github.com/charonX/dsh-skills-manager/releases/download/vX.Y.Z/charonx-dsh-skills-manager-X.Y.Z.tgz
   ```

Git 安装（`git+https://…`）直接读取仓库里提交的 `lib/`、`client/`，不需要构建脚本；旧版本（`v0.1.0`）仍会触发 `prepare` 拦截，不要再用它。
