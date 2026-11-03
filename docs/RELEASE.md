# 发版清单

1. 更新版本与日志：

   ```sh
   npm version patch --no-git-tag-version   # 或 minor / major
   ```

   在 `CHANGELOG.md` 顶部补一段对应版本说明。

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

5. 发布 npm（需要 `npm login`，且拥有 `@charonx` scope）：

   ```sh
   npm publish --access public
   ```

6. 发布后验证两条路径：

   ```sh
   dsh plugin --profile smoke-npm add @charonx/dsh-skills-manager
   dsh plugin --profile smoke-rel add \
     https://github.com/charonX/dsh-skills-manager/releases/download/vX.Y.Z/charonx-dsh-skills-manager-X.Y.Z.tgz
   ```

Git 安装（`git+https://…`）会通过 `prepare` 自行构建，pnpm 默认拦截该脚本，需要「允许并重试」或在 profile 的 `pnpm-workspace.yaml` 写入 pnpm 打印的 `allowBuilds` 键。
