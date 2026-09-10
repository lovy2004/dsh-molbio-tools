# 浏览器内面板：实现记录（路径 A）

> 本文是 [client-pipeline-exploration.md](client-pipeline-exploration.md) 的**实现篇**。
> 那份文档论证了"preset 渠道挂不了客户端 UI、正路是 bundle 渠道的 `dsh.client` 双面包"；
> 本文记录这条路**实际是怎么落地的**、哪些坑是真的、以及当前面板能做什么、不能做什么。

## 1. 已交付的东西

一个浏览器内的 **Molbio** 右栏 tab（`sidebar.right.pane.tab`）：列出当前会话工作区里的
序列文件，选中即在面板里画出——`.dna`/`.gb`/`.gbk` 走质粒图谱，`.fa`/`.fasta` 走
序列标识图。**解析与渲染全部在浏览器里跑本仓库自己的模块**（`lib/genbank/snapgene/
plasmid/msa/logo`），不经过任何工具调用、不落盘 SVG、不弹系统查看器。

| 文件 | 作用 |
| --- | --- |
| `build/client-bundle.mjs` | 零依赖打包器：把浏览器半打成 DSH 客户端加载器要求的 lazy-CJS 产物 |
| `build/browser-api.mjs` | 浏览器安全面：从**包根的 `.mjs` 源文件**再导出面板可用的一切（单一事实来源） |
| `build/panel-core.mjs` | 面板的数据通路（分类/解码/解析/渲染），不含 React，可在 Node 里单测 |
| `build/client-entry.mjs` | 浏览器半本体：注册 tab 类型、正文、标题 chip |
| `lib/client.js` | **构建产物**（`exports["./client"]` 指向它；由 `npm run build:client` 生成） |
| `test/client.mjs` | 按加载器的方式执行产物 + 驱动数据通路（含真实 pUC118 夹具） |
| `test/client-mount.mjs` | 复刻宿主侧图扫描，证明本包与线上 web profile 能挂上、依赖可解析 |

命令：`npm run build:client`（构建）、`npm test`（全部测试）、
`node test/client-mount.mjs --profile web`（针对某个 profile 复核）。

## 2. lazy-CJS 产物格式（官方打包预设未发布，这里是复刻）

官方共享打包预设（monorepo 内的 `tsdown.client.ts`）**没有随 npm 发布**，官方文档也
明说仓库外第三方得自行复刻输出格式。格式本身很小，完全由加载器契约决定：

```js
window.__ModuleLoader__.load({
  id: "dsh-molbio-tools",              // 必须是 package.json 的 name，加载器按它做键
  factory: (require) => {
    var module = { exports: {} };
    /* …模块体… */
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
```

三条硬约束：

1. **执行产物只能"注册"**：所有副作用（含 CSS 注入）必须在 `factory` 闭包内，物化时机
   归加载器管。`test/client.mjs` 用 `vm` + 记录型 `window` 代理断言"注册期间不写任何全局"。
2. **`require` 只能解析有答案的东西**（加载器 `makeRequire` 的顺序）：
   **seed 词**（shell 预置的固定表：`react`、`react/jsx-runtime`、`react-dom`、
   `react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、
   `@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、
   `@deepseek-ai/dsh-client-ui-dockkit`）→ **已物化模块** → **已注册工厂**（即 boot graph
   里的其他行）。落空就抛错——这就是**纯净度门禁的运行时镜像**。
3. **入口必须在 boot graph 里**：宿主扫描 `ctx.loader.entries()`，把"包声明了
   `dsh.client.platform === "web"` 且有 `exports["./client"]`"的行变成 graph 行。

本包的打包器把这套约束**前移成构建期检查**：禁止 `node:` 内建、禁止裸 specifier（除
seed）、禁止动态 `import()`、禁止跨插件值导入。它自己只降低四种构造：声明式导出、
`export {}` 列表、`export … from` 再导出、`a as b` 绑定——正好覆盖本仓库的模块风格。

## 3. 运行时用到的东西（以及为什么不用别的）

| 需要 | 从哪来 | 为什么不选替代 |
| --- | --- | --- |
| 文件字节 | `ctx.remote.workspaceFiles.readAll(path)`（base64 → `Uint8Array`） | 面板只读；`readAll` 给完整字节，SnapGene 的 `.dna` 是二进制，`read()` 的行窗口拿不到 |
| 目录列表 | `ctx.remote.workspaceFiles.list(path)` | 返回 `{name, type, size?}`，路径用 `/` 拼接 |
| 工作区根目录 | `useSessions((s) => s.byId[sessionId]?.cwd)` | **框架自动注入**：`slots.provideRoot({hooks:{sessions}})` 把每个 root hook 合成为 `use<Name>` prop，所以正文**不需要**自己声明它 |
| 会话 id / actions | 插槽框架注入的 `sessionId` | 面板自己的 `inject` 工厂只需交出 `remote` |
| tab 类型注册 | `ctx.sidebarRightTabs.register({id, kind, title, guide})` | `patterns` 省略即"页类型"（按 kind 打开），第三方默认优先级带 `extension` |
| 正文 / 标题 | keyed 座位 `sidebar.right.pane.tab` / `…tab.title`，key = 类型的 `id` | —— |

**没有做宿主侧 RPC**：面板需要的一切（序列解析、图谱/logo 渲染）都是纯计算，直接在浏览器
里跑同一份源码即可，省掉 Typert Remote 注册这一整块不确定性与版本耦合。将来若要做
**文献库面板**（读 `papers.json`、写笔记），`workspaceFiles` 的 `readAll`/`write` 仍不够
表达"按 PMID 去重/更新"这类语义，那时再评估要么走宿主 RPC、要么把库文件也当普通文件读写。

## 4. 上限与已知限制（都是设计取舍，不是未修的 bug）

- **文件大小**：`readAll` 的上限是部署配置 `maxFileBytes`（默认 **32 MiB**），
  `list` 的条目上限 `maxEntries`（默认 **2000**）。超限是明确的 wire 错误，面板原样显示。
- **面板只读**：只列目录第一层，不递归、不写文件。
- **表格截断**：特征表最多渲染 200 行（图谱本身画全部特征，`renderPlasmidMap` 自身上限 200）。
- **图片式交互**：SVG 里注入的是真实 DOM（可缩放、可选中文本），但没有点特征跳转之类的联动。
- **CSS 内联**：产物刻意不注入样式表——`factory` 里的样式副作用要自己管拆除；
  内联样式让产物保持单文件、零生命周期负担。
- **每次改源都要重新构建**：`lib/client.js` 是**产物**，改了根 `.mjs` 或 `build/*.mjs` 后
  必须重跑 `npm run build:client`，否则面板还跑旧逻辑（这与 preset 的"版本目录"规则是
  两码事：客户端产物靠 `rev` 哈希缓存失效，不靠目录名）。

## 5. 怎么验证（以及什么还没验证）

已自动验证（`npm test`）：

1. **产物格式**：`test/client.mjs` 在 `vm` 里执行产物，断言"注册一个工厂、id 正确、
   注册期无全局写入"，再用桩 `require` 物化它，断言 `apply`/`inject` 与
   `require` 只用到 `react`。
2. **服务契约**：对桩服务 `apply()`，断言 tab 类型（`id`/`kind`/`title`/`guide`、
   无 `patterns`）、两个 keyed 座位的注册、正文 `inject` 工厂只交出 `remote`。
3. **数据通路**：真实 pUC118 `.dna` → 记录（名称/长度/拓扑/特征，AmpR 2102-2962 反链）
   → SVG；GenBank 文本路径与 Node 工具解析结果**逐字段一致**；FASTA → 比对 → logo；
   扩展名分类、排序、base64 解码、非法输入的错误路径。
4. **能否真的挂上**：`test/client-mount.mjs` 读**真实 web profile 的组合**（bundle 的
   `insert:` 行，用 harness 自己的 YAML 方言解析），对每一行复刻宿主扫描（最近的
   `package.json` + `dsh.client` + `exports["./client"]` 文件存在性），断言：
   本包走的是与所有线上客户端包相同的分支；`dsh.client.inject` 里声明的两个包
   （sidebar-right / connection）**本身就是 graph 行**；产物的 `require` 全部有答案。
   实测：152 行挂载行中 53 个是 client 行。

**尚未验证（需要真实浏览器）**：React 组件在真实 DOM 里的渲染、插槽框架注入的
`useSessions` 是否在运行时按预期出现、右栏 guide 页里胶囊的排布。这些只能在运行中的
GUI 里点一下才能确认——自动测试到不了那里（本机没有可用的无头浏览器，且页面本身有
trust 网关 401）。

## 6. 挂载与分发

面板走 **bundle 渠道**（preset 渠道依旧只能给工具，见探索文档第 2 节的三层排除）：

```powershell
dsh plugin --profile <profile> add D:\path\to\dsh-molbio-tools   # 本地目录
dsh plugin --profile <profile> add dsh-molbio-tools              # 或 npm 包
```

宿主加载该行后：客户端扫描发现 `dsh.client` → 图里多一行
`/plugins/dsh-molbio-tools/client.js?rev=<hash>` → 页面刷新时按需拉取、物化、执行
`apply`。**不需要重建 Web 应用**（这正是客户端模块体系的设计目的）。

与 preset 渠道共存时：preset 提供 46 个工具，bundle 提供面板；同名工具由 preset 层
shadow（无冲突），面板的 `remote`/`slot` 服务不受影响。

## 7. 下一步

- **真机确认**：装上后在右栏 guide 页应出现 "Molbio" 胶囊；打开工作区里任意 `.dna`
  或 `.gb` 应直接出图。
- **第二个面板**：文献库（`papers.json`）——需要先决定数据面（宿主 RPC 还是文件读写）。
- **`tool.call.toolview`**：同一个渲染器还能挂成 `molbio_plasmid_map` 的自定义调用卡，
  让工具调用本身显示图而不是只给路径；属于同一份 `panel-core.mjs` 的复用。
- **上游提案（路径 B）**：preset 渠道挂 client 仍是真实生态需求，可以在社区反馈时
  引用本文第 2 节的扫描规则（相对 specifier 已可解析，缺的只是"preset 子树参与扫描"）。
