# 外置 bundle 开发要点（harness 无官方文档部分的实测记录）

本文记录 dsh-manager 作为**仓库外（out-of-tree）bundle** 接入 deepseek-harness 时踩实的机制，均以 harness 0.2.2-rc.2 实测为准。来源：ticket 01 的开发过程。

## 1. bundle 清单与安装

package.json 两个声明字段：

```jsonc
{
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "client": { "platform": "web", "inject": ["remote", "slots", "locale"] }
}
```

- `dsh.bundle.patch`：Host 侧插件行（cordis.patch.yml）。单行插入：
  ```yaml
  - insert:
      - id: dsh-manager
        name: dsh-manager
  ```
- `client`：浏览器侧入口声明。`platform: "web"` 决定它进入 web roster；`inject` 是客户端入口插件的服务注入（`window.__ModuleLoader__` 的目标模块）。

安装与验证（dsh CLI 全局安装，版本对齐 0.2.2-rc.2）：

```bash
dsh plugin --profile <name> add D:/.../packages/manager   # pnpm link 进 profile 层
dsh --dump-config --profile <name>                        # 能看到 `# == dsh-manager` + 插入行
```

注意 CLI 的 WARN：link 进来的包的 peerDependencies 不从目标 node_modules 解析——宿主 profile 层已带这些包，实际无碍，但升级 harness 版本时 peer 范围必须同步。

## 2. 客户端包的构建产物形状（/client 导出）

浏览器 `/client` 产物不是普通 ESM，而是 **CJS ModuleLoader 工厂**：

```js
window.__ModuleLoader__.load({ id: 'dsh-manager', factory: (require) => { ... return exports; } })
```

tsdown 关键配置（tsdown 的 `output:` 键会被静默忽略，必须用顶层键）：

- 顶层 `banner` / `footer` 包住工厂闭包；
- `outputOptions: { entryFileNames: 'client.js' }` + `outExtensions: () => ({ js: '.js' })`；
- `external: (id) => PLATFORM_MODULES.includes(id)` —— 外部模块走 `require(...)`，由 shell 注入（react、zod、cordis、ui-* 等基线，见 `packages/client/web/src/platform.ts`）；peer deps 会被 tsdown 自动外部化，需要 `noExternal` 抢回（如 typert-protocol）；
- CSS module 需要 `@tsdown/css`；产物里的 style.css 不会被 shell 自动加载，用 `import x from './x.module.css?inline'` + 幂等 `<style>` 注入。

## 3. Host 侧装饰器

`@Remote` 是 TS 装饰器，Node 目前不原生解析。harness 用 typert generator 的 `decoratorPlugin`（`ts.transpileModule` 降级）在打包前转译；外置包照抄同一变换（见 `tsdown.host.config.ts` 的 `decoratorLowering`）。没有它，`lib/index.js` 里残留 `@Remote`，Node 报 `Invalid or unexpected token`。

## 4. typert / Remote：无 generator 的手写等价物

generator 只在 harness workspace 内跑（依赖 workspace 布局）。仓库外可手写生成物等价的两块：

1. `src/remote.ts`：`createTypertRemoteInfo(spec, z)`（来自 `@deepseek-ai/dsh-typert-protocol/remote-info`），spec 形状照抄生成器产物（`typert.remote-client.js`）。Gateway SRC fallback 允许零参 JSON 调用不依赖生成 descriptor。
2. 模块增强：`TypertRemoteNamespace<NS>` + `TypertRemoteNamespaceMap`，让客户端拿到精确类型的 `ctx.remote.<ns>.<method>()`。

Generator 集成留到后续 ticket（需要 workspace 级 tsconfig 布局）。

## 5. 客户端 slot 注册（full page）

- 全页 = `'main'` slot（kind `keyed`，scope `root`，key = MainPanelId）+ `'sidebar.panellist'` 导航行（kind `list`，scope `root`）。
- locale 字典经 `ctx.locale.register(NS, { zh, en })` 注册；entry 声明 `locale: NS` 拿到 `t` seat。**渲染器要求 locale face 由 locale 插件 `ctx.slots.installLocale()` 安装**，缺了直接 SlotAssemblyError。
- 验证入口有两个接缝：
  - 主接缝：进程内 `loadProfile + createRuntimeResolution + boot`（`tests/boot/boot-test-profile.ts`），Launcher facts 必须手工补：`cmdlineArgs`、`appExit`、`appReady`、`profileContext`，否则 `dsh-hmr`/`web-startup` 等整链挂起。
  - 客户端接缝：`SlotTestRuntime`（jsdom）。注意：`'main'` 是 keyed slot，`renderSlot('main', {}, { entryKey: PANEL_ID })` 必须给 entryKey；`declare` 的形状要与 SlotMap 一致（`{ kind: 'keyed' | 'list', scope: 'root' }`），空对象声明会渲染空 frame。

## 6. 测试解析（vitest）

npm 发布的 dsh 包 `/client` 出口指向 CJS 工厂，jsdom 测试台必须加载 **TS 源**（每个 npm 包都随包发布 `src/`）。harness 用 tsconfig paths 实现，外置包在 `vitest.config.ts` 用 `resolve.alias` 达成同等效果（见该文件 `FACADE` 表）。别名只覆盖客户端图需要的包；primitives 只别名到 `src/icons/index.tsx`（barrel 会拖进 shiki/katex）。

## 7. 版本纪律

所有 `@deepseek-ai/*` 以 devDependencies **精确** `0.2.2-rc.2` 安装（npm `dist-tags.next`；`latest` 标签错误地指向 0.0.1-rc.1）。peer 声明范围须与 harness 版本策略一致。
