# DSH STORE 上架证据（一次性 Profile：安装 / 启动 / 卸载）

本文件记录提交给 DSH STORE 的**兼容声明**及其证据。证据固定在提交本次声明的 commit 上，
下面的命令可以原样重跑；所有状态都写进临时 `DSH_HOME`，不触碰真实的 `~/.dsh`。

## 1. 声明了什么

根包 [`package.json`](../package.json) 与面板包
[`packages/molbio-panel/package.json`](../packages/molbio-panel/package.json) 各声明一份：

```jsonc
"engines": {
  "node": ">=24",
  "dsh": ">=0.2.1-rc.2 <0.3.0-0"
},
"dsh": {
  "compatibility": {
    "dshReleases": {
      "0.2.1-rc.1": "unknown",
      "0.2.1-rc.2": "compatible",
      "0.2.1-rc.3": "compatible",
      "0.2.1-rc.4": "unknown",
      "0.2.1-rc.5": "compatible"
    }
  }
}
```

`dsh` 引擎范围的上界写成 `<0.3.0-0` 而不是 `<0.3.0`，是因为 DSH 用
`semver.satisfies(..., { includePrerelease: true })` 判断（见
`@deepseek-ai/dsh-app-boot` 的 `unmetRequirements`）：带 prerelease 选项时 `<0.3.0`
会放行 `0.3.0-alpha.1`，而 `-0` 不会。

### 为什么 rc.2 / rc.3 / rc.5 是 compatible、rc.1 / rc.4 是 unknown

| 版本 | 记录 | 依据 |
| --- | --- | --- |
| 0.2.1-rc.1 | unknown | 早于本包基线（0.20.1 钉 `0.2.0-rc.2`），未在此版本上运行过；同时也不在 `engines.dsh` 范围内 |
| 0.2.1-rc.2 | compatible | 0.21.0 / 0.21.1 的发布基线；本文件第 3 节的一次性 Profile 流程在 rc.2 上跑过；`contract` / `preset-health` / `smoke` 均通过 |
| 0.2.1-rc.3 | compatible | 0.22.0 的发布基线；同一套一次性 Profile 流程在 rc.3 上重跑通过（安装 → 启动 HTTP 200 → 卸载无残留）；`contract` / `preset-health` / `drift-probe` / `benchmark-profile` / `smoke` 在 rc.3 上全绿。上游 `standard` 行清单与 rc.2 **逐字节一致** |
| 0.2.1-rc.4 | unknown | 没有在真实安装上跑过；不能因为"补丁号在 `engines.dsh` 范围内"就写成 compatible |
| 0.2.1-rc.5 | compatible | 0.22.2 的发布基线（CI 钉该版本）。在本机 DSH 桌面版 0.2.1-rc.5 上重跑：安装 → 启动 HTTP 200 → `agentPresets/list` 的 `broken` 为空且 molbio-lab 的 `tool-molbio` 为 `fiberPhase: "active"` → 卸载无残留；`contract` 17 / `preset-health` 30 行 / `drift-probe` 16 / `smoke` 60 工具 / `bench:offline` 61 题全绿。上游 `standard` 与 rc.3 **逐字节一致**（6799 B，同一 sha256） |

## 2. 环境

| 项 | 值 |
| --- | --- |
| DSH | `0.2.1-rc.5`（桌面版 `app.asar`，同一份代码也是 CI 的 npm 基线） |
| Node.js | `v24.21.0`（DSH 桌面版内嵌的 Node，Electron 44.7.0） |
| pnpm | `11.28.5`（DSH bundle 内） |
| 平台 | Windows（win32 x64） |

## 3. 一次性 Profile 的完整流程

`DSH_HOME` 指向一个临时目录，profile 从官方 `web` 模板新建：

```bash
export DSH_HOME=<workspace>/.tmp/dsh-store-check
npm pack --pack-destination "$DSH_HOME"          # 得到 dsh-molbio-tools-0.22.2.tgz
dsh --profile molbio-tgz-check --from-default-profile web --dump-config
dsh plugin --profile molbio-tgz-check add "$DSH_HOME/dsh-molbio-tools-0.22.2.tgz"
dsh --profile molbio-tgz-check --dump-config      # 安装后的组合树
dsh --profile molbio-tgz-check --no-open --port 0 # 启动，打印 URL
curl "http://127.0.0.1:<port>/?token=<token>"     # 读回页面
dsh plugin --profile molbio-tgz-check remove dsh-molbio-tools
dsh --profile molbio-tgz-check --dump-config      # 卸载后的组合树
```

安装用 **tarball** 而不是目录，因为 tarball 就是发布物本身：它能同时证明 `files`
白名单带全了运行文件（`host.mjs`、`lib/client.js`、单个 `cordis.patch.yml` 的两个 insert、preset）。

tarball 是 **115 个文件 / 约 1.02 MB**（`npm pack` 实测约 1,024,000 B，解包约 3.3 MB；再改文档会让字节数
小幅浮动，文件数不变），且 `package/packages/**` 为 **0**：根包不再内嵌
`packages/molbio-panel`，一个 tarball 里只有一个插件清单（面板包按自己的地址单独发布）。
面板本身没有因此消失——根包的 `lib/client.js` 就带着它，第 3.2 节的回读可以作证。

下面这次是在 **0.22.2 的 tarball** 上、用 **dsh 0.2.1-rc.5** 的 CLI 重跑的（2026-10-30），
文件数与发布物一致；更早的记录只差版本号与文件数，流程未变。

### 3.1 安装

```
+ dsh-molbio-tools file:D:/.../dsh-molbio-tools-0.22.2.tgz
Packages: +1
Done in 571ms
```

安装后的 `--dump-config` 出现 bundle 层，且 `host.mjs` 解析到**已安装包内**：

```
# == dsh-molbio-tools
- id: molbio-client
  name: file:///.../profiles/molbio-tgz-check/node_modules/dsh-molbio-tools/host.mjs
- id: preset-molbio-lab
  config:
    id: molbio-lab
    ...
      - id: tool-molbio
        name: dsh-molbio-tools
```

### 3.2 启动

```
dsh web: http://127.0.0.1:50071/?token=...
```

读回结果：`HTTP 200`、38180 字节；页面里的 `window.__DSH_BOOT__` 图包含
`dsh-molbio-tools/client.js&rev=…`（rev 是内容哈希，随产物变化），即浏览器半被宿主 Loader 发现并进了客户端图——
这是"启动成功"的可观察证据，而不只是进程没退出。（先用 token 换 cookie，再带 cookie 读 `/`，
否则第一跳是 303。）

再用同一 cookie POST `/api/agentPresets/list` 与 `/api/pluginInventory/list`（envelope 见
[rules.md](rules.md) 规则 1）：`broken` 为空（空数组时服务端直接省略该键），molbio-lab 的
`tool-molbio` 为 `fiberPhase: "active"`——preset 里的 60 个工具**真的挂上了**，
而不只是组合树正确。

### 3.3 卸载

```
- dsh-molbio-tools file:D:/.../dsh-molbio-tools-0.22.2.tgz
Done in 421ms
```

卸载后四项同时回到初始状态：

| 检查 | 结果 |
| --- | --- |
| `package.json` 的 `dependencies` | 无 `dsh-molbio-tools` |
| `package.json` 的 `dsh.profile.bundles` | 只剩 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` |
| `--dump-config` 中的 `molbio` 引用 | **0** |
| `node_modules` 与 lockfile | 无残留；lockfile importer 为空 |

## 4. 补充：从本地目录安装

`dsh plugin --profile <p> add <仓库路径>` 同样走通安装 / 启动 / 卸载。唯一差异：卸载后
pnpm 的 hoisted linker 会在 `node_modules/` 留下一个指向仓库目录的孤儿 junction
（已不在 lockfile、dependencies、bundles 中，`--dump-config` 也不引用它）。这是 pnpm 对
目录 link 的清理行为，不是插件状态残留；用 tarball 安装时该残留不出现。

## 5. 仓库内验证（同一基线）

```
node test/contract.mjs       → 17 checks passed（host 契约、client 产物、tarball 覆盖、声明回退的突变自检）
node test/preset-health.mjs  → all 30 rows load on dsh 0.2.1-rc.5
node test/smoke.mjs          → registered 60 tools, all smoke tests passed
node test/drift-probe.mjs    → 16/16（14 个突变全部被抓到）
node benchmark/run.mjs --offline → 61 tasks checked against the shipped tools
```

`test/release.mjs` 在完整权限的本地会话里整套通过（包括末尾的 npm 版本探测）；
在受限沙箱里该探测会拿到 `EPERM`（Node 以管道捕获子进程输出被拒绝），属环境限制，不是插件问题。

## 6. 上架路径

这是包含两个 DSH 插件的 monorepo，两个包分别提交明确的 tree 地址：

```
https://github.com/lovy2004/dsh-molbio-tools/tree/main
https://github.com/lovy2004/dsh-molbio-tools/tree/main/packages/molbio-panel
```

两者各自带有本文件第 1 节的 `engines` 与 `dsh.compatibility.dshReleases` 声明。
