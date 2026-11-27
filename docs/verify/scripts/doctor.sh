#!/usr/bin/env bash
#
# 只读 Doctor 脚本：检查 repos/dsh 的 harness 产物、插件构建产物、web profile 链接及 3080 端口存活。
# 不修改任何源码、profile 或运行时状态，严禁打印任何 token 或凭据。
#
set -uo pipefail

VERIFY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_ROOT="$(cd "$VERIFY_DIR/../.." && pwd)"
HARNESS="$DSH_ROOT/deepseek-harness"
PROFILE="${DSH_PROFILE:-web}"
PORT="${DSH_VERIFY_PORT:-3080}"
PROFILE_PKG="$HOME/.dsh/profiles/$PROFILE/package.json"

fail=0

echo "== dsh verify doctor =="
echo "dsh_root: $DSH_ROOT"
echo "profile:  $PROFILE"
echo "port:     $PORT"
echo

echo "-- 1. deepseek-harness build freshness --"
marker="$HARNESS/packages/client/ui-slots/lib/types/index.d.ts"
if [ ! -f "$marker" ]; then
  echo "[FAIL] missing harness build marker: $marker"
  echo "       run: (cd $HARNESS && pnpm run build)"
  fail=1
else
  stale_harness=()
  while IFS= read -r pkgdir; do
    [ -f "$pkgdir/lib/index.js" ] || continue
    if find "$pkgdir/src" -name '*.ts' -newer "$pkgdir/lib/index.js" -print -quit 2>/dev/null | grep -q .; then
      stale_harness+=("${pkgdir#"$HARNESS/packages/"}")
    fi
  done < <(find "$HARNESS/packages" -mindepth 2 -maxdepth 2 -type d)

  if [ ${#stale_harness[@]} -gt 0 ]; then
    echo "[FAIL] stale harness build in ${#stale_harness[@]} package(s), e.g. ${stale_harness[0]}"
    echo "       run: (cd $HARNESS && pnpm run build)"
    fail=1
  else
    echo "[PASS] harness build artifacts are up to date"
  fi
fi
echo

echo "-- 2. workspace plugins build freshness --"
node - "$DSH_ROOT" <<'NODE' || fail=1
const fs = require('node:fs')
const path = require('node:path')

const root = process.argv[2]
const pluginsDir = path.join(root, 'plugins')

function newestMtime(dir, exts) {
  let latest = 0
  if (!fs.existsSync(dir)) return 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const m = newestMtime(full, exts)
      if (m > latest) latest = m
    } else if (exts.some(ext => entry.name.endsWith(ext))) {
      const m = fs.statSync(full).mtimeMs
      if (m > latest) latest = m
    }
  }
  return latest
}

let staleCount = 0
for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const dir = path.join(pluginsDir, entry.name)
  const pkgPath = path.join(dir, 'package.json')
  if (!fs.existsSync(pkgPath)) continue
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  if (!pkg.dsh?.bundle) continue

  const hasClient = fs.existsSync(path.join(dir, 'src/client/index.tsx')) || fs.existsSync(path.join(dir, 'src/client/index.ts'))
  const srcTime = newestMtime(path.join(dir, 'src'), ['.ts', '.tsx', '.css'])
  const hostRel = typeof pkg.main === 'string' ? pkg.main : 'lib/index.js'
  const hostOut = path.join(dir, hostRel)
  const clientExp = pkg.exports?.['./client']
  const clientRel = typeof clientExp === 'string'
    ? clientExp
    : (typeof clientExp?.default === 'string' ? clientExp.default : 'client/client.js')
  const clientOut = path.join(dir, clientRel)

  const hostOk = fs.existsSync(hostOut) && fs.statSync(hostOut).mtimeMs >= srcTime
  const clientOk = !hasClient || (fs.existsSync(clientOut) && fs.statSync(clientOut).mtimeMs >= srcTime)

  if (!fs.existsSync(hostOut) && srcTime === 0) {
    console.log(`[SKIP] ${pkg.name} (skeleton / no source yet)`)
    continue
  }
  if (!hostOk || !clientOk) {
    staleCount += 1
    console.log(`[FAIL] ${pkg.name} build missing or stale (hostOk=${hostOk}, clientOk=${clientOk})`)
  } else {
    console.log(`[PASS] ${pkg.name}`)
  }
}

if (staleCount > 0) process.exit(1)
NODE
echo

echo "-- 3. profile link integrity --"
if [ ! -f "$PROFILE_PKG" ]; then
  echo "[WARN] profile manifest not found: $PROFILE_PKG"
else
  node - "$PROFILE_PKG" "$DSH_ROOT" <<'NODE' || fail=1
const fs = require('node:fs')
const path = require('node:path')

const [profilePkgPath, dshRoot] = process.argv.slice(2)
const pkg = JSON.parse(fs.readFileSync(profilePkgPath, 'utf8'))
const deps = pkg.dependencies ?? {}
let bad = 0
for (const [name, spec] of Object.entries(deps)) {
  if (typeof spec !== 'string' || !spec.startsWith('link:')) continue
  const target = spec.slice(5)
  const exists = fs.existsSync(target)
  const insideRepo = target.startsWith(dshRoot + path.sep) || target === dshRoot
  if (!exists || !insideRepo) {
    bad += 1
    console.log(`[FAIL] ${name} -> ${target} (exists=${exists}, insideRepo=${insideRepo})`)
  } else {
    console.log(`[PASS] ${name} -> ${path.relative(dshRoot, target)}`)
  }
}
if (bad > 0) process.exit(1)
NODE
fi
echo

echo "-- 4. repo hygiene & verify-doc consistency --"
if node "$DSH_ROOT/scripts/check-repo-hygiene.mjs"; then
  :
else
  fail=1
fi
echo

echo "-- 5. dsh web server probe (127.0.0.1:$PORT) --"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  root_code=$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/" || echo "000")
  echo "[INFO] listener active on 127.0.0.1:$PORT (root=$root_code)"
else
  echo "[WARN] no listener on 127.0.0.1:$PORT (start via ./dev.sh or cd deepseek-harness && pnpm dsh web --port $PORT)"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "doctor verdict: READY (static artifacts & links healthy)"
  exit 0
else
  echo "doctor verdict: NOT READY (fix FAIL items above before driving)"
  exit 1
fi
