# 客户端管线探索：浏览器面板的可行性与实现路径

> 调研时间：v15 之后。目标：评估路线图中"质粒图谱浏览器内实时面板"与"文献库浏览器端面板"的可行性并给出实现路径。
> **结论先行：preset 渠道无法挂客户端 UI（组合/发现/运行时推送三层机制挡住）；官方支持的正路是 bundle 渠道的 `dsh.client` 双面包（dual-face package）；动态插件系统可做快速原型。**
> 证据来源：(1) 本机 DSH 0.1.1-rc.2 安装目录源码（`C:\Users\18771\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`，下称 NMN，含行号）；(2) 官方文档站 `deepseek-harness.github.io` 与 DeepWiki；(3) 本机运行页面实测的 Slot 查询。

## 1. 浏览器客户端插件的现有机制（bundle 渠道，官方支持）

客户端插件组合**不是构建时打进 web bundle**，而是宿主启动时扫描 + 运行期按需加载：

1. 一个 npm 包在 `package.json` 声明双面入口（真实例子：`NMN\dsh-client-ui-cordis\package.json`）：

   ```jsonc
   {
     "exports": {
       ".": { "default": "./lib/index.js" },           // 宿主半边
       "./client": { "default": "./lib/client.js" }     // 浏览器半边（预构建产物，随包发布）
     },
     "dsh": {
       "client": {
         "platform": "web",                  // 必须
         "inject": ["@deepseek-ai/dsh-client-ui-settings-plugins"],  // 可选：外部化依赖
         "external": [...],                  // 可选
         "immediately": false                 // 可选
       }
     }
   }
   ```

2. 宿主半边 `ClientModuleRegistry`（`NMN\dsh-client-modules\lib\index.js` L258-303）：
   - 扫描 **`ctx.loader` 条目**（L290、L421-437），条目名 = 包名，用 `createRequire(ctx.baseUrl).resolve(<包>/package.json)` 解析（L276）——**只有从配置目录可解析的 npm 包才能被扫到**；
   - 解析 `dsh.client`（L120-134，`platform` 必须为 `"web"`）与 `exports["./client"]`（L136-146，缺失即报错）；产物必须是已构建的 lazy-CJS 文件，缺失时报 `client bundle not found; run pnpm run build`（L89-103）；
   - 哈希成 rev，路由 `/plugins/<id>/client.js?rev=<rev>`（L152-161、L459-490），向 `webserver/index-inject` 注入 `window.__ModuleLoader__` + parser-blocking 预加载 + `window.__DSH_BOOT__` 引导图（L209-250）。

3. 浏览器半边（`NMN\dsh-client-modules\lib\client.js`）：解析 `__DSH_BOOT__`，经典 `<script>` 按需拉取 bundle，工厂式 CJS 表延迟物化；**React 与 Cordis 由 shell 预播种**（隐式 external），其余共享包按 `dsh.client.inject` 的图边排序（provider 先于 consumer）。

4. 官方文档与之互证：
   - [client-modules 子系统文档](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/client-modules)（wire 协议 `WebBootEntry`/`WebBootGraph`；扫描锚点 = 配置树 `ctx.baseUrl` 的"包依赖"模型）；
   - [新增设置卡片 cookbook](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-settings-card)：浏览器半 `apply(ctx)` 经 `ctx.slots.inject('settings.plugin.item', () => ctx.slots.register(...))` 注册 UI，并明确"**只要 cordis.yml 挂载了该插件，它就出现在页面上——无需重建 Web 应用**"；
   - [新增 Conversation Node cookbook](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-conversation-node)：在 Chat 流里挂业务面板（`ctx.slots.inject('conversation.chat.node', ...)`）。

5. 宿主↔客户端通信：客户端 `ctx.connection`（`NMN\dsh-client-connection\README.md`：HTTP POST unary/respond + WebSocket 事件流，走宿主 `/api` 桥）；宿主半边用 Typert Remote 暴露 RPC 端点，由 API Proxy 认领（"a registered Typert interceptor claims its Remote endpoints before the API Proxy fallback"）。

## 2. 为什么 preset 渠道不行（三层挡住）

证据：`NMN\dsh-agent-presets\lib\index.js` 与 `dsh-client-modules`；官方文档侧无任何 preset 挂 client 的说法，与代码一致。

1. **组合层**：preset 的 `agent.cordis.yml` 由 `PresetTree.import()` 在**宿主进程**按 ESM URL import（L469-524、L707-735），挂载在 per-session scope，全程无 client 分支。
2. **发现层**：客户端扫描只遍历 `ctx.loader.entries()`；preset 子树"直接插入（plugged directly rather than created as a loader entry, never links itself to an Entry）"（L454-457），**永不进入 loader.entries()**——即使 preset 目录里放一个带 `dsh.client` 的包也不会被扫进 `__DSH_BOOT__`，也没有 `/plugins/<id>/client.js` 路由。
3. **运行时推送层**：唯一的"浏览器按需取宿主侧客户端代码"通道是动态插件系统的 Typert Remote `getClientCode`（`dsh-cordis-host-runner` → 浏览器 `new Function` 求值 → `__ModuleLoader__.load`，见 `NMN\dsh-cordis-client-runner\lib\client.js` L889/L166/L549），只读动态注册表 `plugin.packages`，受 session 所有权与审批约束；`ClientModuleRegistry` 没有 `register(id, code)` 运行时 API。

Typert manifest 与客户端无关：它是宿主侧 RPC/API 反射（`validateTypertManifest` 硬性要求 `face === "host"`，`NMN\dsh-typert-loader\lib\index.js` L81），无 client 入口字段。

## 3. 运行页面的 Slot 面（实测，面板可挂点）

来自本机运行页面的 `Slots.listSubTree`（client 平台）。相关可挂点：

| Slot | 协议 | 用途 |
| --- | --- | --- |
| `tool.call.toolview` | keyed，key = 工具名，open 域 | **按工具名注册自定义调用卡**：`molbio_plasmid_map*` 的卡片内直接渲染质粒图（现有 taken 列表无 molbio_*，无冲突） |
| `conversation.view` | list（id/order/label） | 会话内新增整个视图标签（"Plasmids" 图谱库、"Papers" 文献库） |
| `shell.overlay` | list，root 域浮层 | 全局浮动面板（需自行处理显示/隐藏与层级） |
| `settings.section` | list | 插件的完整设置页 |
| `conversation.input.dock` / `composer.dock` / `chat.turnTail` | list/chain | 附加小条/行 |

两个目标面板的合理落点：
- **质粒图谱实时面板**：首选 `tool.call.toolview` 注册 `molbio_plasmid_map` / `molbio_plasmid_map_file` 的自定义卡（图直接画在工具调用卡里，替代"写 SVG + 系统查看器"），辅以 `conversation.view` 图谱库页。
- **文献库面板**：`conversation.view` 的 "Papers" 页（列表/更新/去重），或 `shell.overlay` 浮层；数据经宿主 RPC 读写 `papers.json`。

## 4. 关键实践缺口（动手前必须知道）

1. **官方打包预设未发布**：构建 client bundle 的共享 `clientBundle` tsdown 预设（monorepo 内 `packages/client/tsdown.client.ts`）**未随包发布**；官方文档明确仓库外第三方"得自行复刻同样的输出格式"——即 **lazy-CJS factory 产物**（执行 bundle 只注册 `window.__ModuleLoader__.load({id, factory})`，副作用全部延迟到物化）。
2. **bundle 纯净度门禁**：client bundle 禁止跨插件值导入（type-only import 允许）。
3. **无官方第三方端到端示例**：官方样例全是内部包（`packages/client/*`，紧耦合 monorepo）；社区已有按 `dsh.client`/Slot 实操的第三方包（如 `@hytime/dsh-client-ui-shortcuts`、`dsh-web-preview-panel` 等，兼容性需自行验证）。
4. 动态插件通道（tool-cordis）是独立通道：宿主存源码 → Typert Remote `getClientCode` → `new Function` 求值。**适合原型，不适合分发**（进程内存、不持久）。

## 5. 可行路径与权衡

| 路径 | 说明 | 代价 | 定位 |
| --- | --- | --- | --- |
| **0. 维持现状** | SVG 文件 + auto-view | 零 | 短期可接受 |
| **A. bundle 双面包** | npm 包加 `dsh.client` + `exports["./client"]` + 随包发布预构建 lazy-CJS 的 `client.js`（esbuild 自建产物格式），宿主半边用 Typert Remote 暴露 RPC | 发布时新增构建步骤；需复刻 lazy-CJS 格式并通过纯净度门禁；peerDependencies 指向公开发布的 `@deepseek-ai/dsh-client-*`；真机验证 inject 列表与 Slot 注册 | **推荐：唯一无需改 DSH 核心的浏览器 UI 之路** |
| **B. 上游核心改造** | 向 DSH 提需求：preset 声明客户端包并上交 `ClientModuleRegistry`（或给 registry 加运行时注册 API） | 依赖上游节奏，本仓库无法单独交付 | 长期提案（"preset 渠道挂 client"是真实生态需求，值得反馈） |
| **C. 动态插件原型** | 用本平台动态 Cordis 插件（code.client + Slots）先做面板 UX 原型 | 进程内存、仅本会话 | **动手前先做**：验证面板交互与 Slot 落点，再移植到 A |
| **D. 混合分发** | preset 提供工具（现状）+ 可选 `dsh plugin add dsh-molbio-tools` 装 bundle 获得面板；bundle 宿主半边同时挂载（同名工具被 preset shadow，RPC 服务不受影响） | 面板 RPC 走 bundle 宿主半边，与 preset 工具需同源发布、版本对齐 | A 的落地形态之一 |

## 6. 实施 A 的待验证清单（逐项确认后再动手）

1. 第三方包的 `dsh.client.inject` 最小集合：隐式基线（React/Cordis/静态 UI 库/parser 预加载 runtime）之外还需显式声明哪些 `@deepseek-ai/dsh-client-*`（slots/connection/runtime 等）；它们的 npm public access 与 peerDependencies 解析。
2. lazy-CJS factory 产物的精确输出格式（对照官方内部包的 `lib/client.js` 反推，或社区包先例）。
3. 第三方包注册 Typert Remote 端点的最小姿势（`bindTypertRemote`/`@Remote`），确认 `dsh plugin add` 安装的包能正常声明 Remote。
4. `tool.call.toolview` 与 `conversation.view` 的注册 props（owner props / session 数据从哪拿），以及替换风险。
5. 版本目录规则不受影响（preset 渠道照旧）；bundle 的 host/client 半随 npm 版本同源发布即可。

## 7. 0.1.2-alpha.2 更新后的重新验证（2026-08-31）

DSH 升级到 0.1.2-alpha.2（全量包替换）后，按上文章节逐项复查：

**结论：总体结论不变——preset 渠道仍不能挂客户端 UI，bundle 渠道 `dsh.client` 双面包仍是正路；但传输层细节变化较大，路径 B（上游改造）的缺口收窄了。**

### 不变的部分（原结论继续生效）

1. **`dsh.client` 声明格式不变**：`{ platform, inject?, external?, immediately? }` + `exports["./client"]` 预构建 lazy-CJS 产物（新版 `dsh-client-modules/lib/index.js` L140-166 与旧版逐字段一致）；缺失 bundle 仍报 `MissingClientBundleError`。
2. **preset 渠道三层排除仍然成立，且更显式**：新版 `dsh-agent-presets/lib/index.js` L617-642 `PresetTree` 构造函数**主动 `delete owner.subtree`**（注释原文保留："A subtree plugged directly (rather than created as a loader entry) never links itself to an Entry"）；`dsh-agent-presets` 全库无任何 client 相关代码（仅两处无关 "client" 字样）；客户端扫描仍只迭代 `ctx.loader.entries()`（`dsh-client-modules` L756-762）。
3. **运行时推送层不变**：动态插件通道 `getClientCode` @Remote 仍在（`dsh-cordis-host-runner` L1436/L1818-1826）；`ClientModuleRegistry` 仍无 `register(id, code)` 运行时 API（新版只新增了 `processOne`/`resolveSource`/`reconcilePackage` 的扫描内部重构）。
4. **动态插件原型通道不变**（Slot `tool.view.cordis` key `self` 仍在）。
5. **实践缺口仍在**：lazy-CJS factory 产物格式与纯净度门禁要求不变；官方 `clientBundle` 打包预设仍未随 npm 发布（npm 侧无新增构建工具包）。

### 变化的部分

1. **扫描解析升级为按条目树多源**：旧版是单一 `createRequire(全局 baseUrl).resolve(包名/package.json)`；新版 `locatePkgJson`（L660-690）按 `entry.parent.tree.ctx.baseUrl` 逐条解析，支持**相对/`file:` 说明符**（经 `internal.resolveSync` 走 Loader 真实解析 + `nearestPackage` 向上找最近的 package.json）。同名包若从多个活动树解析到会**响亮报错**（"resolves from multiple active Loader sources ... remove one entry"，L797-799）。
2. **传输协议改为分阶段批次**：`/plugins/??<id1>/client.js,<id2>/client.js&rev=…` 批量 URL；boot 注入分 `bootstrap`（parser 阻塞）与 `application`（preload）两个批次（L373-431）；`serveBundle` 改为从预构建的响应表按资源 URL 应答 + immutable 缓存（L838-858）。包侧契约不受影响。
3. **Slot 面微调**：目标落点 `tool.call.toolview`（key=工具名，taken 列表无 molbio_*，无冲突）与 `conversation.view` **均保留且注册协议不变**；新增 `settings.models.provider-card`/`settings.models.footer`、`conversation.approval.detail`、`conversation.trajectory.images`；`conversation.chat.node` 的 keyDomain 增加 `system-prompt`/`turn-process`。
4. `dsh-client-modules` 自身现在声明 `immediately: true` + 空 `inject`。

### 对路径选择的影响

- **路径 A（bundle 双面包）**：实现方式不变；新约束是"同一包名不能从多个 Loader 源同时解析"（多 profile 同装同包时注意去重）。
- **路径 B（上游改造）**：缺口收窄——发现层的解析机制已能处理相对/file 说明符，缺的只剩"让 preset 直接子树参与扫描"（或暴露 preset 行为扫描源）这一环，向上游提需求时可以引用这个具体点。
- **路径 C/D**：不受影响。

## 8. 0.1.5-alpha.1 更新后的重新验证（2026-09-09，新增 right sidebar）

DSH 升级到 0.1.5-alpha.1（9/9 全量替换），新增右侧栏（right sidebar / dockkit）体系。逐项复查：

**结论：核心结论仍然成立——preset 渠道仍不能挂客户端 UI，bundle 渠道 `dsh.client` 仍是正路；新增的右栏 tab 体系是更好的面板落点（仍是 client 半能力，走路径 A 实现）。**

### 不变的部分（原结论继续生效）

1. **`dsh.client` 声明与扫描机制不变**：`dsh-client-modules` 0.1.5 与 0.1.2 逐点一致——`parseDshClient`（L140）、`exports["./client"]` 预构建 lazy-CJS、`/plugins/??` 批量 URL、`__DSH_BOOT__`、扫描只迭代 `ctx.loader.entries()`（L475/L777）、按 `entry.parent.tree.ctx.baseUrl` 逐条目树解析 + `locatePkgJson`/`nearestPackage`（L679-710）。
2. **preset 渠道排除不变**：`dsh-agent-presets` L618 注释（"plugged directly ... never links itself to an Entry"）+ L638 `delete owner.subtree` 原样保留；全库无 client 代码。
3. **动态插件通道不变**：`getClientCode` @Remote 仍在（L1436/L1818）。
4. **实践缺口不变**：lazy-CJS 产物格式、纯净度门禁、官方打包预设未发布。

### 新增：right sidebar 扩展体系（0.1.5 新能力）

新包：`dsh-client-ui-sidebar-right`（dockkit 上的产品层）、`dsh-client-ui-sidebar-files`、`dsh-client-ui-sidebar-textpreview`。实测 Slot 面新增 `rightbar` 列（scope: session）：

- `sidebar.right.pane.tab`（keyed，key = tab 类型 id，无 taken）——tab 正文
- `sidebar.right.pane.tab.title`（keyed）——tab 标题 chip
- `sidebar.right.tab.menu.item`（list）——tab 菜单追加项
- `sidebar.right.tab.guide`（chain）——guide tab 正文
- `conversation.session.header.corner`（single）——面板展开按钮座

**tab 类型对第三方开放**（`dsh-client-ui-sidebar-right/README.md`"Extension seats"）：`ctx.sidebarRightTabs.register({ id, kind, patterns?, priority?, canOpen?, title, guide? })`——README 明确 "the shipped guide type goes through exactly the same public path a type from another package does（`ui-sidebar-textpreview` 是活证）"；`extension` 带是资源认领的最高优先级（未指明时默认）。正文经 `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: definition.id }, Body)`，经 `useTabInfo()` 读 `{ sidebar, panel, tab }`。类型注册活在注册它的 client 插件生命周期内（`ctx.effect`）。

**对本插件的意义**：
- 两个面板的最优落点从"conversation.view 页/浮层"升级为**右栏 tab**：可注册 `Plasmids`（`patterns: ["**/*.dna", "**/*.gb"]` 资源类型，或按 kind 打开的页类型，正文画质粒图/特征列表）与 `Papers`（页类型，读 papers.json 列表）。
- 仍是 **client 半能力**：第三方 client 插件需在 `dsh.client.inject`/external 声明 `@deepseek-ai/dsh-client-ui-sidebar-right`（依赖其 `ctx.sidebarRightTabs`/`ctx.sidebarRight`）并作为 peerDependency 安装——给第 6 节待验证项 1 追加一条。
- preset 渠道依旧无法使用该体系。

### 其它小变化（与本插件无关）

- `tool.call.toolview` taken 列表新增 `read_image`（新工具）；`conversation.input.overlay` 移到 composer.bar 下。
- 目标落点 `tool.call.toolview` / `conversation.view` / `shell.overlay` 均保留、注册协议不变。

### 对路径选择的影响

- **路径 A（bundle 双面包）**：方式不变；落点优先级更新——右栏 tab（`sidebar.right.pane.tab`）最适合图谱/文献面板，`tool.call.toolview` 仍适合工具调用卡的即时图谱，二者可组合。
- **路径 B/C/D**：不受影响。
