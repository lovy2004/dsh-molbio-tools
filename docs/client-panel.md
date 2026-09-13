# 浏览器内面板：实现记录（路径 A）

> 本文是 [client-pipeline-exploration.md](client-pipeline-exploration.md) 的**实现篇**。
> 那份文档论证了"preset 渠道挂不了客户端 UI、正路是 bundle 渠道的 `dsh.client` 双面包"；
> 本文记录这条路**实际是怎么落地的**、哪些坑是真的、以及当前面板能做什么、不能做什么。

## 1. 已交付的东西

两个浏览器内的右栏 tab，外加一个对话内的工具卡：

| 落点 | 内容 | 数据来源 |
| --- | --- | --- |
| **Molbio**（右栏 tab） | 列出会话工作区里的序列文件，选中即画：`.dna`/`.gb`/`.gbk` → 质粒图谱 + 特征表；`.fa`/`.fasta`（≥2 条）→ 序列标识图 | `workspaceFiles.readAll`（二进制，含 SnapGene） |
| **Papers**（右栏 tab） | 把 `molbio_paper_*` 工具维护的 `papers.json` 渲染成可搜索的阅读列表 + 详情面板（标题/作者/期刊/年份/PMID/URL/标签/笔记，标题链接到 PubMed 或原 URL） | `workspaceFiles.read`（文本） |
| **图谱调用卡**（`tool.call.toolview`） | `molbio_plasmid_map` / `molbio_plasmid_map_file` 的调用卡：在对话里直接画出这次调用产出的图谱（摘要行 + 写入路径），失败时显示错误文本与 Inspect 入口 | 工具自己声明的 `output.presentationMeta`（见下） |

**解析与渲染全部在浏览器里跑本仓库自己的模块**（`lib/genbank/snapgene/plasmid/msa/logo`），
不经过任何工具调用、不落盘 SVG、不弹系统查看器。

### 调用卡的数据通路（`presentationMeta`）

这是本仓库第一个**跨越宿主/客户端边界**的能力，通道是官方文档写明的那条：

```
工具 execute() 产出 value
   ↓  工具层对 ROOT 调用执行 output.presentationMeta(args, value)
会话事件携带 meta
   ↓  浏览器把它作为 tool-result 块的 block.meta
tool.call.toolview 卡片读取 block.meta 并绘制
```

三个要点：**`presentResult`/`presentCall` 不算数**——`dsh-tools` 的文档明确写着内置 Web
客户端不消费它们；结构化数据的唯一通道是 `presentationMeta`（官方 read 卡片就这么做）。
**只在 root 调用上执行**（`exec.parent === void 0`），子调用没有 meta。**投影必须廉价且不抛**：
它跑在工具调用已经成功之后，抛错会把这次调用标成失败，所以实现里只做纯计算（图谱标记
用一份有界的内存缓存，按写入路径取回，不去读文件）。

SVG 随 meta 传输有上限（256 KB）：真实载体的图谱 20-60 KB，但超大构建可能是 MB 级、会进
会话日志——超限时投影改带 `svg_omitted` 与字节数，卡片降级为提示 + 写入路径（图谱仍在
文件里，`openFile` 一点即开）。卡片对 meta 的态度是**校验而非信任**：缺失/异种/异形一律
降级为提示，绝不在对话里抛错。

| 文件 | 作用 |
| --- | --- |
| `build/client-bundle.mjs` | 零依赖打包器：把浏览器半打成 DSH 客户端加载器要求的 lazy-CJS 产物，**一趟构建产出两个交付包** |
| `build/browser-api.mjs` | 浏览器安全面：从**包根的 `.mjs` 源文件**再导出面板可用的一切（单一事实来源） |
| `build/panel-core.mjs` | 面板的数据通路（分类/解码/解析/渲染/文献库投影），不含 React，可在 Node 里单测 |
| `build/client-entry.mjs` | 浏览器半本体：两个 tab 类型的注册、正文、标题 chip，以及两个 map 工具的调用卡 |
| `lib/client.js` | **构建产物**（`exports["./client"]` 指向它；由 `npm run build:client` 生成） |
| `packages/molbio-panel/` | 面板专用包（宿主半边空实现），面板与 52 个工具解耦的交付通道 |
| `test/client.mjs` | 按加载器的方式执行产物 + 驱动两条数据通路（含真实 pUC118 夹具） |
| `test/map-card.mjs` | 调用卡的**跨界**检查：真实工具的投影 → 卡片读取 → 渲染出 SVG（含四种降级路径） |
| `test/client-mount.mjs` | 复刻宿主侧图扫描，证明两个包都能挂上、依赖可解析 |

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
| 文件文本 | `ctx.remote.workspaceFiles.read(path)`（行窗口） | `papers.json` 是文本；行窗口足够且省带宽。**"文件不存在"被单独识别**（wire 码 `workspace-file/not-found`）——不存在的库是"空库"，坏掉的库是"错误"，面板不让这两者看起来一样 |
| 目录列表 | `ctx.remote.workspaceFiles.list(path)` | 返回 `{name, type, size?}`，路径用 `/` 拼接 |
| 工作区根目录 | `useSessions((s) => s.byId[sessionId]?.cwd)` | **框架自动注入**：`slots.provideRoot({hooks:{sessions}})` 把每个 root hook 合成为 `use<Name>` prop，所以正文**不需要**自己声明它 |
| 会话 id / actions | 插槽框架注入的 `sessionId` | 面板自己的 `inject` 工厂只需交出 `remote` |
| tab 类型注册 | `ctx.sidebarRightTabs.register({id, kind, title, guide})` | `patterns` 省略即"页类型"（按 kind 打开），第三方默认优先级带 `extension`；同一包注册两个页类型即两个 tab（各自一个 guide 胶囊，`order` 决定排布） |
| 正文 / 标题 | keyed 座位 `sidebar.right.pane.tab` / `…tab.title`，key = 类型的 `id` | 座位**先 inject 再 register**，见下 |
| 座位声明 | `ctx.slots.inject(座位名, () => ctx.slots.register({name: 座位名, …}, 组件))` | 裸 `register()` 在座位尚未被声明时**抛异常**；异常逃出 `apply()` = 加载器 entry 失败 = GUI 起不来（0.7.1 原样踩过，见 §4） |

**没有做宿主侧 RPC**：两个面板需要的一切（序列解析、图谱/logo 渲染、文献库投影）都是纯
计算，直接在浏览器里跑同一份源码即可，省掉 Typert Remote 注册这一整块不确定性与版本耦合。

**文献库面板是只读的**（刻意）：写回需要 `molbio_paper_add`/`update` 的去重与合并语义，
而那几个工具的并发契约是"不安全"（`isConcurrencySafe: false`）——面板在背后写同一个文件，
就必须把这套契约重新实现一遍才能避免丢更新。所以面板只读并指向工具；要改库就用工具。

## 4. 上限与已知限制（都是设计取舍，不是未修的 bug）

- **座位必须先被"声明"，且不是本包说了算**（这条是纪律，不是限制）：客户端座位只有在**拥有它的
  那条 entry 在自己的 `children` 表里声明之后**才存在。`sidebar.right.pane.tab` 由右栏的
  `rightbar.session` entry 声明，`tool.call.toolview` 更是 ui-tool 的 `conversation.chat.node`
  entry 的**子座位**。本包的 entry 与这两条之间**没有任何顺序保证**，所以每一处注册都必须
  `ctx.slots.inject(座位名, …)`（座位已声明则立即执行、未声明则等声明到达、重声明时先撤销再重放，
  贡献随 fiber 销毁）。0.7.1 用裸 `register()` 抢 `tool.call.toolview`，抛出的
  `slot "tool.call.toolview" is not declared (a parent entry's children table must declare it)`
  直接让本包的加载器 entry 失败——症状是 HARNESS 顶栏 **Failed to load plugins**、整个 Web GUI
  起不来，而不是"少一个 tab"。`test/slots-stub.mjs` 与 `test/contract.mjs` 各钉一遍这条规则。
- **文件大小**：`readAll` 的上限是部署配置 `maxFileBytes`（默认 **32 MiB**），
  `list` 的条目上限 `maxEntries`（默认 **2000**）；`read` 一次最多 `maxLines`（默认 5000）行。
  超限是明确的 wire 错误，面板原样显示。
- **面板只读**：都只列目录第一层、不递归、不写文件（文献库面板写回的理由见上一节）。
- **表格截断**：质粒特征表最多渲染 200 行（图谱本身画全部特征，`renderPlasmidMap` 自身上限 200）。
- **文献库无分页**：整库渲染成一个列表；上千条时靠搜索/标签过滤，没有虚拟滚动。
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
2. **服务契约与抢座位的顺序**：对桩服务 `apply()`，断言**两个** tab 类型（`id`/`kind`/`title`/
   `guide`、无 `patterns`、guide `order` 40/41）、四个 keyed 座位的注册、两个正文的 `inject`
   工厂都只交出 `remote`。座位那一层从**一个座位都没声明**的最坏顺序启动（`test/slots-stub.mjs`
   复刻 shell 的 SlotCore 语义）：`apply()` 必须不抛；右栏座位声明后四条注册落地；调用卡座位在
   ui-tool 声明之前一直**处于等待**、声明之后才落地；重声明不产生重复注册；并当场复刻
   "未声明座位 `register()` 必抛"的那条 SlotCore 异常——0.7.1 把整个 GUI 卡在
   "Failed to load plugins" 的就是它。
3. **组件行为**：`test/panel-render.mjs` 把**真实的面板组件**放进 Node 跑——没有 React
   （harness 里有，浏览器里的 React 由 shell 播种）也没有 DOM，所以这个文件自带一套最小
   钩子宿主（`createElement`/`useState`/`useEffect`/`useMemo`/`useRef`，语义与 React 一致：
   状态跨渲染保留、副作用在渲染后执行、setter 触发重渲染、依赖比较用 `Object.is`）、
   桩服务（`sessionId`/`useSessions`/`remote`）与 DOM/DOMParser 桩。然后断言用户能看到的东西：
   文件列表（目录与不可打开的文件不出现）、点选 `.dna` → 元信息 + 特征表 + **SVG 真的被
   append 进宿主**（`svg` 元素、`viewBox` 属性）、点选 `.fasta` → logo 表头、读取失败与
   列目录失败的错误态、文献库的列表/搜索/标签过滤/详情/PubMed 链接回退、空库提示、坏库
   报错（**不显示成"空库"**）、以及卸载时中止在途读取。
   这一层抓到过三个真 bug：列表把不可打开的文件也列出来、`sortEntries` 的 `other` 档从不
   生效、以及坏库时列表仍宣称"还没有文献"。
4. **数据通路（质粒）**：真实 pUC118 `.dna` → 记录（名称/长度/拓扑/特征，AmpR 2102-2962
   反链）→ SVG；GenBank 文本路径与 Node 工具解析结果**逐字段一致**；FASTA → 比对 → logo；
   扩展名分类、排序、base64 解码、非法输入的错误路径。
5. **数据通路（文献库）**：`readWorkspaceText` 的三种结果（有文本 / 文件不存在 / 读取失败）
   分别对应"有库 / 空库 / 报错"；`parseLibrary` 与工具侧契约一致（`{papers: [...]}`）且
   坏 JSON 明确报错；标签统计与排序、搜索（标题/作者/期刊/年份/PMID/URL/笔记/标签 + 标签
   组合成 AND）、详情字段的固定顺序与空值跳过、摘要行、链接回退（url → PubMed → 无）；
   并断言面板的库文件名与 `papers.mjs` 的 `DEFAULT_LIBRARY_FILE` **同源**。
6. **宿主契约**：`test/contract.mjs` 把面板依赖的**运行时契约**钉在已安装的 DSH 上——它读的是
   宿主与官方客户端包的**实际代码**，而不是本仓库的假设：
   - shell 里钩子 prop 的命名规则（`standardHookPropName`：`use` + 首字母大写 + 其余），
     也就是把 root hook `sessions` 变成 prop `useSessions` 的那条规则；
   - 官方同类包（`ui-sidebar-files`）的正文 props 与注入服务，证明 `sessionId` / `useSessions` /
     `ctx.remote.workspaceFiles` 就是我用的那套；
   - `sessions` 这个 root hook **由谁提供**（`ui-session` 的 `slots.provideRoot`）以及它安装的
     session scope；
   - `workspaceFiles` 的 `list`/`readAll`/`read` 在**宿主 Remote** 上的实现、`not-found` wire 码
     与 base64 载荷，以及官方客户端包对同一命名空间的调用方式；
   - 本包产物**自己那一侧**：inject 列表、两个 keyed 座位的注册、三个 Remote 调用的实参顺序、
     正文解构的 props 名，以及"inject 工厂只交出 `remote`"（保证不会遮蔽框架注入的
     `sessionId`/钩子）。
   - **座位声明纪律**（第 10 项）：shell 仍拒绝"未声明座位"的注册、slots 服务仍提供
     `inject(key, callback)`、官方包仍用它抢 `tool.call.toolview` / `sidebar.right.pane.tab`，
     并且**本包产物里每一处 `slots.register` 都落在对应座位的 `slots.inject` 里**（逐一配对，
     且两者总数相等——新加一个裸 `register` 会当场失败）。
   任何一条失败都意味着"DSH 动了面板依赖的东西"——这正是 0.1.5-alpha.2 弄坏 preset 的方式
   （插件契约变了、测试全绿、组合却挂不上），所以这里断言的是**契约**（规则、调用、服务名），
   不是排版细节。

7. **调用卡（跨界）**：`test/map-card.mjs` 是唯一同时驱动宿主与客户端的一层——它把真实
   插件注册进 mock registry、**真的调用** `molbio_plasmid_map`、像工具层那样调用
   `output.presentationMeta(args, value)`，再把投影喂给卡片的读取函数与组件，断言 SVG
   真的进了卡片的宿主节点。它同时钉住四条降级路径：异种 meta、缺失 meta、超限（带
   `svg_omitted`）、调用失败——任何一条都不允许在对话里抛错。

8. **能否真的挂上**：`test/client-mount.mjs` 读**真实 web profile 的组合**（bundle 的
   `insert:` 行，用 harness 自己的 YAML 方言解析），对每一行复刻宿主扫描（最近的
   `package.json` + `dsh.client` + `exports["./client"]` 文件存在性），断言：
   **两个包**走的分支与所有线上客户端包相同；`dsh.client.inject` 里声明的两个包
   （sidebar-right / connection）**本身就是 graph 行**；产物的 `require` 全部有答案。
   实测：153 行挂载行中 54 个是 client 行（含本包自己的那一行）。

**真机验证（2026-09-11，无头浏览器 + 专用 profile）**：用一个独立 profile
（`dsh-base` + `dsh-web-app` + `dsh-molbio-tools` 0.7.2）起了独立实例，在真实页面里确认：

- 页面 boot 正常，boot graph 含本包，**无 `Failed to load plugins`**；
- 驱动一次真实对话调用 `molbio_plasmid_map` → **图谱调用卡在对话里画出图谱**：卡片摘要
  `pCARD-LIVE · 212 bp · circular · 1 feature(s) · 2 cut mark(s)`、1 个
  `viewBox="0 0 840 840"` 的 SVG（520×520 渲染）、以及写入路径——而不是只给一个文件路径；
- 右栏引导页出现 **Molbio** 与 **Papers** 两个胶囊及描述。

复现这套验证的工具：`build/cdp.mjs`（Chrome DevTools Protocol 的最小驱动：导航 / 求值 / 截图）与
`build/cdp-drive.mjs`（把提示词真正打进输入框并等到这一轮结束）。一个坑：composer 是
`contenteditable` 的 div，`textContent = …` **不会**被 React 看到，必须走
`document.execCommand('insertText')` 这条原生编辑路径，否则"发送"按钮始终是禁用的。

## 6. 挂载与分发

面板走 **bundle 渠道**（preset 渠道依旧只能给工具，见探索文档第 2 节的三层排除）：

```powershell
dsh plugin --profile <profile> add D:\path\to\dsh-molbio-tools   # 本地目录
dsh plugin --profile <profile> add dsh-molbio-tools              # 或 npm 包
```

宿主加载该行后：客户端扫描发现 `dsh.client` → 图里多一行
`/plugins/dsh-molbio-tools/client.js?rev=<hash>` → 页面刷新时按需拉取、物化、执行
`apply`。**不需要重建 Web 应用**（这正是客户端模块体系的设计目的）。

与 preset 渠道共存时：preset 提供 52 个工具，bundle 提供面板；同名工具由 preset 层
shadow（无冲突），面板的 `remote`/`slot` 服务不受影响。

## 7. 下一步

- **`tool.call.toolview`**：✅ 已落地（见第 1 与第 3 节），覆盖两个 map 工具。可继续做的
  是给 `molbio_sequence_logo` / `molbio_grna_design` 之类的工具也加上卡片（同一套
  `presentationMeta` + 卡片模式）。**注意上线前先跑 `test/client.mjs` 的抢座位顺序那一层**：
  0.7.1 的卡片因为裸 `register()` 抢座位而让 GUI 起不来（0.7.2 修复，见 §4 第一条）。
- **文献库写回**（可选）：若要面板内编辑笔记/标签，需要先定义与 `molbio_paper_*` 工具
  一致的并发契约（乐观版本号或串行化队列），或让工具走同一条 RPC。
- **上游提案（路径 B）**：preset 渠道挂 client 仍是真实生态需求，可以在社区反馈时
  引用本文第 2 节的扫描规则（相对 specifier 已可解析，缺的只是"preset 子树参与扫描"）。
