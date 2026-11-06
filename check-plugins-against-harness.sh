#!/usr/bin/env bash
#
# 用本地 deepseek-harness checkout 的**已构建**产物校验各插件仓库。
#
# 为什么不能只跑插件仓库自己的 `pnpm typecheck`：
# 发布的 @deepseek-ai/dsh-client-* 包不声明其同级类型包依赖（dsh-client-store、
# dsh-client-shortcuts 等），插件用 skipLibCheck:true 时这些 import 解析失败会被
# 静默降级为 any，整条 slot 组合类型链失效 → 假绿。本脚本把所有 @deepseek-ai/*
# 依赖改写成 link: 指向 harness checkout，让插件与宿主处于同一实例（和真实运行时
# 一致），类型检查才有意义。
#
# 用法：
#   ./check-plugins-against-harness.sh                # 校验全部顶层 dsh-* 插件
#   ./check-plugins-against-harness.sh dsh-autoloop   # 只校验指定仓库
#   ./check-plugins-against-harness.sh --skip-build   # 不自动重建 harness
#   ./check-plugins-against-harness.sh --keep         # 保留临时工作目录便于排查
#
# 退出码：0 全部通过；1 有仓库失败或前置条件不满足。

set -uo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
harness="$root/deepseek-harness"
skip_build=0
keep=0
plugins=()

for arg in "$@"; do
  case "$arg" in
    --skip-build) skip_build=1 ;;
    --keep) keep=1 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) plugins+=("$arg") ;;
  esac
done

if [ ! -d "$harness" ]; then
  echo "missing harness checkout: $harness" >&2
  exit 1
fi

if [ ${#plugins[@]} -eq 0 ]; then
  for dir in "$root"/plugins/*/; do
    [ -f "$dir/package.json" ] && plugins+=("plugins/$(basename "$dir")")
  done
  for dir in "$root"/dsh-*/; do
    [ -f "$dir/package.json" ] && plugins+=("$(basename "$dir")")
  done
fi

# ---- 前置条件：harness 必须已构建，且构建产物不比源码旧 ---------------------
marker="$harness/packages/client/ui-slots/lib/types/index.d.ts"
if [ ! -f "$marker" ]; then
  echo "harness is not built (missing $marker)." >&2
  echo "run: (cd deepseek-harness && pnpm run build)" >&2
  exit 1
fi

stale=()
while IFS= read -r pkgdir; do
  [ -f "$pkgdir/lib/index.js" ] || continue
  if find "$pkgdir/src" -name '*.ts' -newer "$pkgdir/lib/index.js" -print -quit 2>/dev/null | grep -q .; then
    stale+=("${pkgdir#"$harness/packages/"}")
  fi
done < <(find "$harness/packages" -mindepth 2 -maxdepth 2 -type d)

if [ ${#stale[@]} -gt 0 ]; then
  echo "harness build is stale for ${#stale[@]} package(s), e.g. ${stale[0]}"
  if [ "$skip_build" -eq 1 ]; then
    echo "refusing to verify against stale artifacts; re-run without --skip-build" >&2
    exit 1
  fi
  echo "rebuilding harness..."
  ( cd "$harness" && pnpm run build ) || { echo "harness build failed" >&2; exit 1; }
fi

# ---- @deepseek-ai/* 包名 -> checkout 目录 ------------------------------------
work=$(mktemp -d "${TMPDIR:-/tmp}/dsh-plugin-check.XXXXXX")
trap '[ "$keep" -eq 1 ] && echo "kept work dir: $work" || rm -rf "$work"' EXIT

node - "$harness" "$work/packages.json" <<'EOF'
const fs = require('fs')
const path = require('path')
const [harness, out] = process.argv.slice(2)
const map = {}
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.name === 'package.json') {
      try {
        const pkg = JSON.parse(fs.readFileSync(full, 'utf8'))
        if (pkg.name?.startsWith('@deepseek-ai/') && pkg.version) map[pkg.name] = path.dirname(full)
      } catch {}
    }
  }
}
walk(path.join(harness, 'vendor'))
walk(path.join(harness, 'packages'))
fs.writeFileSync(out, JSON.stringify(map))
EOF

# ---- 逐插件：复制 -> link 依赖 -> install -> typecheck / test / build -------
declare -a results=()
failed=0

for name in "${plugins[@]}"; do
  if [ -f "$root/$name/package.json" ]; then
    src="$root/$name"
  elif [ -f "$root/plugins/$name/package.json" ]; then
    src="$root/plugins/$name"
    name="plugins/$name"
  else
    results+=("$name|MISSING|")
    failed=1
    continue
  fi

  dst="$work/${name//\//-}"
  mkdir -p "$dst"
  cp -R "$src/" "$dst/"
  rm -rf "$dst/node_modules" "$dst/lib" "$dst/client/client.js" "$dst/.git" "$dst/pnpm-lock.yaml"

  node - "$dst/package.json" "$work/packages.json" <<'EOF'
const fs = require('fs')
const [manifest, mapFile] = process.argv.slice(2)
const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'))
const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'))
const linked = new Set()
for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
  for (const [dep, range] of Object.entries(pkg[field] ?? {})) {
    if (map[dep]) { pkg[field][dep] = `link:${map[dep]}`; linked.add(dep) }
  }
}
fs.writeFileSync(manifest, JSON.stringify(pkg, null, 2) + '\n')
console.log(`linked ${linked.size} harness package(s)`)
EOF

  echo "=== $name"
  if ! ( cd "$dst" && pnpm install >/dev/null 2>&1 ); then
    results+=("$name|INSTALL|failed"); failed=1; continue
  fi

  status=()
  step() {
    local label=$1 script=$2
    if ! node -e "process.exit(require('$dst/package.json').scripts?.['$script'] ? 0 : 1)"; then
      status+=("$label:skip")
      return 0
    fi
    local log="$dst/.$script.log"
    if ( cd "$dst" && pnpm run "$script" ) >"$log" 2>&1; then
      status+=("$label:pass")
      return 0
    fi
    if grep -q "No test files found" "$log"; then
      status+=("$label:skip")
      return 0
    fi
    status+=("$label:FAIL")
    tail -25 "$log"
    return 1
  }

  ok=1
  step typecheck typecheck || ok=0
  step test test || ok=0
  if [ -f "$dst/src/client/index.tsx" ]; then
    step build build || ok=0
  else
    # 没有 client 半的插件（尚未实现 bundle 前端）不要求产出 client 包。
    status+=("build:skip(no client entry)")
  fi
  if [ "$ok" -eq 0 ]; then
    failed=1
    verdict=FAIL
  elif [ ! -f "$dst/src/client/index.tsx" ]; then
    verdict=WIP
  else
    verdict=PASS
  fi
  results+=("$name|$verdict|${status[*]}")
done

echo
echo "== summary =="
for row in "${results[@]}"; do
  IFS='|' read -r name verdict steps <<<"$row"
  printf '%-24s %-8s %s\n' "$name" "$verdict" "$steps"
done
[ "$failed" -eq 0 ] || exit 1
