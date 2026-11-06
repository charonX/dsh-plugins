#!/usr/bin/env bash
#
# 工作区插件开发启动器。
#
# 扫描本工作区里自建的插件仓库、按需构建，然后把变更送进正在运行的 dsh web。
# 不需要卸载插件，也不需要重启服务。
#
# 两边各自的重载链路（均来自官方实现）：
#   客户端半：dsh-client-hmr 每 500ms stat 轮询每个插件图行的 client bundle，
#     构建产物一变就把该插件热替换进已打开的页面（无需刷新、无需重启）。
#   Host 半：dsh-hmr 在 profile 重新组合时替换"磁盘上已变化的已加载模块"，
#     覆盖 link: 包的目标目录；本脚本通过改写 profile patch 里一行注释来触发
#     这次重新组合（实测有效）。
#
# 注意：不要用 `hmr` 条目的 root 去监听整个插件仓库——实测会以
# `EMFILE: too many open files, watch` 让 hmr 条目整条不激活。patch 触发的
# 重新组合更轻，且不需要常驻 watcher。
#
# 用法：
#   ./dev.sh                     交互：选择要构建的插件，然后重载或启动
#   ./dev.sh -a                  直接构建全部插件（非交互）
#   ./dev.sh -n                  不构建，只启动/重载
#   ./dev.sh --reload-only       只触发一次 Host 半重载
#   ./dev.sh --no-reload         只构建，不触发重载
#   ./dev.sh -p web --port 3080  指定 profile 与端口
#   ./dev.sh --no-start          构建并配置后不启动服务
#   ./dev.sh --link-missing      顺带把未关联的插件加进 profile（默认只提示）
#   ./dev.sh --unlink media      把指定插件从 profile 里取消关联（多次可重复）
#   ./dev.sh --unlink 3          也可以按扫描列表里的编号取消关联
#   ./dev.sh --unlink-unbuilt    取消关联所有"已关联但从未构建成功"的插件
#
# 取消关联只改 profile（移除依赖与 bundle 选择），不动插件仓库本身；
# 之后随时可以用 --link-missing 或 `dsh plugin --profile <p> add <dir>` 重新关联。
#
set -uo pipefail

WORKSPACE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS="$WORKSPACE/deepseek-harness"
PROFILE="${DSH_PROFILE:-web}"
PORT=3080
BUILD_MODE="ask"        # ask | all | none | select
START=1
RELOAD=1
RELOAD_ONLY=0
LINK_MISSING=0
UNLINK_UNBUILT=0
UNLINK_SPECS=()

usage() {
  sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    -a|--all) BUILD_MODE=all ;;
    -n|--no-build) BUILD_MODE=none ;;
    --select) BUILD_MODE=select ;;
    --reload-only) RELOAD_ONLY=1; BUILD_MODE=none ;;
    --no-reload) RELOAD=0 ;;
    --no-start) START=0 ;;
    --link-missing) LINK_MISSING=1 ;;
    -u|--unlink) UNLINK_SPECS+=("${2:?--unlink 需要插件名或扫描编号}"); shift ;;
    --unlink-unbuilt) UNLINK_UNBUILT=1 ;;
    -p|--profile) PROFILE="${2:?--profile 需要名称}"; shift ;;
    --port) PORT="${2:?--port 需要端口}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1（--help 查看用法）" >&2; exit 2 ;;
  esac
  shift
done

PROFILE_DIR="$HOME/.dsh/profiles/$PROFILE"
PROFILE_PATCH="$PROFILE_DIR/cordis.patch.yml"

ok()   { printf '  \033[32m%s\033[0m\n' "$*"; }
warn() { printf '  \033[33m%s\033[0m\n' "$*"; }
bad()  { printf '  \033[31m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

# --- 扫描 ------------------------------------------------------------------

# 每个自建插件一行：name, version, dir, hasClient, stale, linked, hasBuild
scan_plugins() {
  node - "$WORKSPACE" "$PROFILE_DIR" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const [workspace, profileDir] = process.argv.slice(2)

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return undefined }
}
const profile = readJson(path.join(profileDir, 'package.json')) ?? {}
const bundles = new Set(profile.dsh?.profile?.bundles ?? [])

const newest = (dir) => {
  let latest = 0
  const walk = (current) => {
    let entries
    try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      try { latest = Math.max(latest, fs.statSync(full).mtimeMs) } catch {}
    }
  }
  walk(dir)
  return latest
}
const mtime = (file) => {
  try { return fs.statSync(file).mtimeMs } catch { return 0 }
}

const candidateDirs = []
const pluginsDir = path.join(workspace, 'plugins')
if (fs.existsSync(pluginsDir)) {
  for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      candidateDirs.push(path.join(pluginsDir, entry.name))
    }
  }
}
for (const entry of fs.readdirSync(workspace, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'deepseek-harness' || entry.name === 'plugins') continue
  candidateDirs.push(path.join(workspace, entry.name))
}

for (const dir of candidateDirs) {
  const pkg = readJson(path.join(dir, 'package.json'))
  if (pkg?.dsh?.bundle === undefined) continue

  const entryName = path.basename(dir)
  const hasBuild = typeof pkg.scripts?.build === 'string'
  const clientExport = pkg.exports?.['./client']
  const clientEntry = typeof clientExport === 'string' ? clientExport : clientExport?.default
  const clientFile = clientEntry === undefined ? undefined : path.join(dir, clientEntry)
  const hasClient = clientFile !== undefined && fs.existsSync(clientFile)

  const sourceNewest = newest(path.join(dir, 'src'))
  const hostNewest = mtime(path.join(dir, 'lib', 'index.js'))
  const clientNewest = clientFile === undefined ? 0 : mtime(clientFile)
  const stale = !fs.existsSync(path.join(dir, 'lib', 'index.js'))
    || sourceNewest > hostNewest
    || (clientFile !== undefined && sourceNewest > clientNewest)

  console.log([
    pkg.name ?? entryName,
    pkg.version ?? '-',
    dir,
    hasClient ? '1' : '0',
    stale ? '1' : '0',
    bundles.has(pkg.name) ? '1' : '0',
    hasBuild ? '1' : '0',
  ].join('\t'))
}
NODE
}

# --- 构建 ------------------------------------------------------------------

build_plugin() {
  local dir="$1" name="$2"
  local has_build
  has_build=$(node -e 'const p=require(process.argv[1]);process.stdout.write(typeof p.scripts?.build==="string"?"yes":"no")' "$dir/package.json" 2>/dev/null || echo no)
  if [ "$has_build" != "yes" ]; then
    warn "${name}: 没有 build 脚本，跳过"
    return 0
  fi
  printf '  构建 %s ... ' "$name"
  if ( cd "$dir" && pnpm run build >/tmp/dsh-dev-build.log 2>&1 ); then
    printf '\033[32mok\033[0m\n'
    return 0
  fi
  printf '\033[31m失败\033[0m\n'
  sed -n '1,20p' /tmp/dsh-dev-build.log | sed 's/^/    /'
  return 1
}

# --- profile 关联 ----------------------------------------------------------

link_plugin() {
  local dir="$1" name="$2"
  printf '  关联 %s 到 profile %s ... ' "$name" "$PROFILE"
  if ( cd "$HARNESS" && pnpm dsh plugin --profile "$PROFILE" add "$dir" >/tmp/dsh-dev-link.log 2>&1 ); then
    printf '\033[32mok\033[0m\n'
    return 0
  fi
  printf '\033[31m失败\033[0m\n'
  sed -n '1,20p' /tmp/dsh-dev-link.log | sed 's/^/    /'
  return 1
}

# 取消关联：从 profile 的依赖与 bundle 选择里移除，仓库本身不动。
unlink_plugin() {
  local name="$1"
  printf '  取消关联 %s ... ' "$name"
  if ( cd "$HARNESS" && pnpm dsh plugin --profile "$PROFILE" remove "$name" >/tmp/dsh-dev-unlink.log 2>&1 ); then
    printf '\033[32mok\033[0m\n'
    return 0
  fi
  printf '\033[31m失败\033[0m\n'
  sed -n '1,20p' /tmp/dsh-dev-unlink.log | sed 's/^/    /'
  return 1
}

# 把 "--unlink 3" / "--unlink pkg" / "--unlink 目录名" 解析成扫描下标。
# 找不到时输出空串，调用方报告并跳过。
resolve_plugin_spec() {
  local spec="$1" i
  if [[ "$spec" =~ ^#?([0-9]+)$ ]]; then
    i=$((BASH_REMATCH[1] - 1))
    [ "$i" -ge 0 ] && [ "$i" -lt "${#NAMES[@]}" ] && echo "$i"
    return 0
  fi
  for i in "${!NAMES[@]}"; do
    [ "${NAMES[$i]}" = "$spec" ] && { echo "$i"; return 0; }
  done
  for i in "${!DIRS[@]}"; do
    [ "$(basename "${DIRS[$i]}")" = "$spec" ] && { echo "$i"; return 0; }
  done
  echo ""
}

# --- 重载 ------------------------------------------------------------------

# 改写 patch 顶部一行注释，产生一次 profile 变化 → dsh-hmr 重新组合 →
# 已变化的 link: 包被替换。注释行恒定只有一行，反复执行不会堆积。
trigger_reload() {
  [ -f "$PROFILE_PATCH" ] || return 1
  node - "$PROFILE_PATCH" <<'NODE'
const fs = require('node:fs')
const file = process.argv[2]
const MARK = '# dev.sh reload: '
const line = `${MARK}${new Date().toISOString()}（由 dev.sh 维护，用于触发 profile 重新组合）`
const kept = fs.readFileSync(file, 'utf8')
  .split('\n')
  .filter(existing => !existing.startsWith(MARK))
fs.writeFileSync(file, `${line}\n${kept.join('\n').replace(/^\n+/u, '')}`)
NODE
}

is_server_up() {
  curl -sf -m 2 -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null \
    || [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/" 2>/dev/null)" = "401" ]
}

# --- 主流程 ----------------------------------------------------------------

step "扫描工作区插件（profile: ${PROFILE}）"
if [ ! -d "$PROFILE_DIR" ]; then
  bad "找不到 profile 目录：$PROFILE_DIR"
  echo "  先跑一次 (cd deepseek-harness && pnpm dsh --profile $PROFILE) 生成 profile。" >&2
  exit 1
fi
if [ ! -d "$HARNESS/packages/boot/hmr/lib" ]; then
  warn "harness 似乎还没构建过；若启动失败，先在 deepseek-harness 里跑 pnpm run build"
fi

SCAN=$(scan_plugins)
if [ -z "$SCAN" ]; then
  warn "没有扫描到带 dsh.bundle 的插件仓库"
  exit 0
fi

NAMES=(); DIRS=(); CLIENT=(); STALE=(); LINKED=()
while IFS=$'\t' read -r name version dir has_client stale linked has_build; do
  NAMES+=("$name"); DIRS+=("$dir"); CLIENT+=("$has_client"); STALE+=("$stale"); LINKED+=("$linked")
  printf '  [%d] %-38s %-10s client:%s  构建状态:%s  已关联:%s\n' \
    "${#NAMES[@]}" "$name" "$version" \
    "$([ "$has_client" = 1 ] && echo 有 || echo 无)" \
    "$([ "$stale" = 1 ] && echo 需要构建 || echo 最新)" \
    "$([ "$linked" = 1 ] && echo 是 || echo 否)"
done <<< "$SCAN"

# 取消关联先于构建：把"还没开发、但已经在 profile 里"的插件摘掉，
# 免得它的构建失败或半成品拖累启动。
UNLINKED_NAMES=()
UNLINK_FAILED=()
if [ "${#UNLINK_SPECS[@]}" -gt 0 ] || [ "$UNLINK_UNBUILT" = 1 ]; then
  step "取消关联"
  if [ "$BUILD_MODE" = "ask" ]; then BUILD_MODE=none; fi
  TARGETS=()
  for spec in "${UNLINK_SPECS[@]:-}"; do
    [ -n "$spec" ] || continue
    index=$(resolve_plugin_spec "$spec")
    if [ -z "$index" ]; then
      warn "找不到插件：${spec}（用 --help 查看扫描编号）"
      continue
    fi
    TARGETS+=("$index")
  done
  if [ "$UNLINK_UNBUILT" = 1 ]; then
    for index in "${!NAMES[@]}"; do
      [ "${LINKED[$index]}" = "1" ] || continue
      if [ ! -f "${DIRS[$index]}/lib/index.js" ]; then
        TARGETS+=("$index")
      fi
    done
  fi
  if [ "${#TARGETS[@]}" -eq 0 ]; then
    ok "没有需要取消关联的插件"
  else
    for index in "${TARGETS[@]}"; do
      name="${NAMES[$index]}"
      if [ "${LINKED[$index]}" != "1" ]; then
        warn "${name}: 本来就没关联"
        continue
      fi
      if unlink_plugin "$name"; then
        LINKED[$index]=0
        UNLINKED_NAMES+=("$name")
      else
        UNLINK_FAILED+=("$name")
      fi
    done
  fi
fi

SELECTED=()
case "$BUILD_MODE" in
  all)
    for i in "${!NAMES[@]}"; do SELECTED+=("$i"); done
    ;;
  none)
    ;;
  select)
    read -r -p $'\n输入要构建的编号（空格分隔，回车跳过）：' -a picks
    for pick in "${picks[@]:-}"; do
      if [[ "$pick" =~ ^[0-9]+$ ]] && [ "$pick" -ge 1 ] && [ "$pick" -le "${#NAMES[@]}" ]; then
        SELECTED+=("$((pick-1))")
      fi
    done
    ;;
  ask)
    if [ -t 0 ]; then
      read -r -p $'\n选择构建方式 [1] 全部  [2] 选择  [3] 跳过 (默认 1)：' choice
      case "${choice:-1}" in
        1) for i in "${!NAMES[@]}"; do SELECTED+=("$i"); done ;;
        2)
          read -r -p '输入要构建的编号（空格分隔）：' -a picks
          for pick in "${picks[@]:-}"; do
            if [[ "$pick" =~ ^[0-9]+$ ]] && [ "$pick" -ge 1 ] && [ "$pick" -le "${#NAMES[@]}" ]; then
              SELECTED+=("$((pick-1))")
            fi
          done
          ;;
        *) ;;
      esac
    else
      for i in "${!NAMES[@]}"; do SELECTED+=("$i"); done
    fi
    ;;
esac

FAILED=()
if [ "${#SELECTED[@]}" -gt 0 ]; then
  step "构建"
  for index in "${SELECTED[@]}"; do
    build_plugin "${DIRS[$index]}" "${NAMES[$index]}" || FAILED+=("${NAMES[$index]}")
  done
else
  step "构建"
  echo "  跳过"
fi

step "关联"
LINK_FAILED=()
PENDING_LINK=()
for index in "${!NAMES[@]}"; do
  [ "${LINKED[$index]}" = "1" ] && continue
  case " ${UNLINKED_NAMES[*]:-} " in
    *" ${NAMES[$index]} "*) continue ;;
  esac
  PENDING_LINK+=("$index")
done

# 本轮构建失败的插件如果已经在 profile 里，很可能就是它让服务起不来：
# 交互模式下问一句要不要顺手摘掉。
if [ "${#FAILED[@]}" -gt 0 ]; then
  for index in "${!NAMES[@]}"; do
    [ "${LINKED[$index]}" = "1" ] || continue
    case " ${FAILED[*]} " in
      *" ${NAMES[$index]} "*) ;;
      *) continue ;;
    esac
    name="${NAMES[$index]}"
    if [ -t 0 ]; then
      read -r -p "  ${name} 构建失败且仍已关联，现在取消关联？[y/N] " answer
      case "$answer" in
        y|Y)
          if unlink_plugin "$name"; then
            LINKED[$index]=0
            UNLINKED_NAMES+=("$name")
          else
            UNLINK_FAILED+=("$name")
          fi
          ;;
        *) warn "${name}: 仍保持关联（下次启动可能失败）" ;;
      esac
    else
      warn "${name}: 构建失败但已关联（用 --unlink ${name} 取消关联）"
    fi
  done
fi

if [ "${#PENDING_LINK[@]}" -eq 0 ]; then
  ok "没有待关联的插件"
else
  for index in "${PENDING_LINK[@]}"; do
    name="${NAMES[$index]}"
    if [ "$LINK_MISSING" = 1 ]; then
      link_plugin "${DIRS[$index]}" "$name" || LINK_FAILED+=("$name")
      continue
    fi
    if [ -t 0 ]; then
      read -r -p "  ${name} 还没加进 profile ${PROFILE}，现在关联？[y/N] " answer
      case "$answer" in
        y|Y) link_plugin "${DIRS[$index]}" "$name" || LINK_FAILED+=("$name") ;;
        *) warn "${name}: 未关联（需要时执行：(cd deepseek-harness && pnpm dsh plugin --profile ${PROFILE} add ${DIRS[$index]})）" ;;
      esac
    else
      warn "${name}: 未关联。加 --link-missing 可在非交互模式下自动关联"
    fi
  done
fi

SERVER_UP=0
is_server_up && SERVER_UP=1

step "结果"
if [ "${#SELECTED[@]}" -eq 0 ]; then
  ok "构建：跳过"
elif [ "${#FAILED[@]}" -eq 0 ]; then
  ok "构建：${#SELECTED[@]} 个成功"
else
  bad "构建失败：${FAILED[*]}"
fi
[ "${#LINK_FAILED[@]}" -eq 0 ] && ok "关联：就绪" || bad "关联失败：${LINK_FAILED[*]}"
if [ "${#UNLINKED_NAMES[@]}" -gt 0 ]; then
  ok "已取消关联：${UNLINKED_NAMES[*]}"
fi
if [ "${#UNLINK_FAILED[@]}" -gt 0 ]; then
  bad "取消关联失败：${UNLINK_FAILED[*]}"
fi

if [ "$RELOAD_ONLY" = 1 ] || { [ "$RELOAD" = 1 ] && [ "$SERVER_UP" = 1 ] && [ "${#SELECTED[@]}" -gt 0 ]; }; then
  if trigger_reload; then
    ok "已触发 Host 半重载（profile 重新组合）"
    echo "  客户端半无需处理：构建产物变化后约 0.5s 会热替换进已打开的页面。"
  else
    bad "无法触发重载：找不到 ${PROFILE_PATCH}"
  fi
elif [ "$RELOAD" = 0 ]; then
  warn "按 --no-reload 跳过重载触发"
elif [ "$SERVER_UP" = 0 ]; then
  echo "  服务未运行，构建产物会在启动时加载。"
fi

if [ "$START" = 0 ]; then
  echo
  echo "未启动服务（--no-start）。启动： (cd deepseek-harness && pnpm dsh web)"
  exit 0
fi

if [ "$SERVER_UP" = 1 ]; then
  echo
  ok "dsh web 已在 http://127.0.0.1:${PORT} 运行，本次运行没有重启它"
  exit 0
fi

step "启动 dsh web"
cd "$HARNESS"
exec pnpm dsh web --port "$PORT"
