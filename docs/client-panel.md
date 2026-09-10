# 浏览器内面板：实现记录（路径 A）

> 本文是 [client-pipeline-exploration.md](client-pipeline-exploration.md) 的**实现篇**。
> 那份文档论证了"preset 渠道挂不了客户端 UI、正路是 bundle 渠道的 `dsh.client` 双面包"；
> 本文记录这条路**实际是怎么落地的**、哪些坑是真的、以及当前面板能做什么、不能做什么。

## 1. 已交付的东西

两个浏览器内的右栏 tab：

| tab | 内容 | 数据来源 |
| --- | --- | --- |
| **Molbio** | 列出会话工作区里的序列文件，选中即画：`.dna`/`.gb`/`.gbk` → 质粒图谱 + 特征表；`.fa`/`.fasta`（≥2 条）→ 序列标识图 | `workspaceFiles.readAll`（二进制，含 SnapGene） |
| **Papers** | 把 `molbio_paper_*` 工具维护的 `papers.json` 渲染成可搜索的阅读列表 + 详情面板（标题/作者/期刊/年份/PMID/URL/标签/笔记，标题链接到 PubMed 或原 URL） | `workspaceFiles.read`（文本） |

**解析与渲染全部在浏览器里跑本仓库自己的模块**（`lib/genbank/snapgene/plasmid/msa/logo`），
不经过任何工具调用、不落盘 SVG、不弹系统查看器。

| 文件 | 作用 |
| --- | --- |
| `build/client-bundle.mjs` | 零依赖打包器：把浏览器半打成 DSH 客户端加载器要求的 lazy-CJS 产物，**一趟构建产出两个交付包** |
| `build/browser-api.mjs` | 浏览器安全面：从**包根的 `.mjs` 源文件**再导出面板可用的一切（单一事实来源） |
| `build/panel-core.mjs` | 面板的数据通路（分类/解码/解析/渲染/文献库投影），不含 React，可在 Node 里单测 |
| `build/client-entry.mjs` | 浏览器半本体：两个 tab 类型的注册、正文、标题 chip |
| `lib/client.js` | **构建产物**（`exports["./client"]` 指向它；由 `npm run build:client` 生成） |
| `packages/molbio-panel/` | 面板专用包（宿主半边空实现），面板与 46 个工具解耦的交付通道 |
| `test/client.mjs` | 按加载器的方式执行产物 + 驱动两条数据通路（含真实 pUC118 夹具） |
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
| 正文 / 标题 | keyed 座位 `sidebar.right.pane.tab` / `…tab.title`，key = 类型的 `id` | —— |

**没有做宿主侧 RPC**：两个面板需要的一切（序列解析、图谱/logo 渲染、文献库投影）都是纯
计算，直接在浏览器里跑同一份源码即可，省掉 Typert Remote 注册这一整块不确定性与版本耦合。

**文献库面板是只读的**（刻意）：写回需要 `molbio_paper_add`/`update` 的去重与合并语义，
而那几个工具的并发契约是"不安全"（`isConcurrencySafe: false`）——面板在背后写同一个文件，
就必须把这套契约重新实现一遍才能避免丢更新。所以面板只读并指向工具；要改库就用工具。

## 4. 上限与已知限制（都是设计取舍，不是未修的 bug）

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
2. **服务契约**：对桩服务 `apply()`，断言**两个** tab 类型（`id`/`kind`/`title`/`guide`、
   无 `patterns`、guide `order` 40/41）、四个 keyed 座位的注册、两个正文的 `inject`
   工厂都只交出 `remote`。
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
   任何一条失败都意味着"DSH 动了面板依赖的东西"——这正是 0.1.5-alpha.2 弄坏 preset 的方式
   （插件契约变了、测试全绿、组合却挂不上），所以这里断言的是**契约**（规则、调用、服务名），
   不是排版细节。

7. **能否真的挂上**：`test/client-mount.mjs` 读**真实 web profile 的组合**（bundle 的
   `insert:` 行，用 harness 自己的 YAML 方言解析），对每一行复刻宿主扫描（最近的
   `package.json` + `dsh.client` + `exports["./client"]` 文件存在性），断言：
   **两个包**走的分支与所有线上客户端包相同；`dsh.client.inject` 里声明的两个包
   （sidebar-right / connection）**本身就是 graph 行**；产物的 `require` 全部有答案。
   实测：153 行挂载行中 54 个是 client 行（含本包自己的那一行）。

**尚未验证（需要真实浏览器）**：只剩"页面里的实际观感"——两个 tab 是否出现在右栏引导页、
点击后 SVG 是否如预期呈现。上一版列出的三件"只有运行时能回答的事"现在已被 `contract.mjs`
用**已安装的框架代码**钉住（钩子 prop 规则、root hook 提供方、Remote 的 wire 形状与方法
签名），失败会直接以测试形式暴露，而不是等页面白屏。

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

- **真机确认**：装上并重启后，右栏引导页应出现 **Molbio** 与 **Papers** 两个胶囊；
  Molbio 打开工作区里任意 `.dna`/`.gb` 应直接出图，Papers 在有 `papers.json` 的会话里
  应列出条目。
- **`tool.call.toolview`**：同一套渲染器还能挂成 `molbio_plasmid_map` 的自定义调用卡，
  让工具调用本身显示图而不是只给路径；`panel-core.mjs` 可直接复用。
- **文献库写回**（可选）：若要面板内编辑笔记/标签，需要先定义与 `molbio_paper_*` 工具
  一致的并发契约（乐观版本号或串行化队列），或让工具走同一条 RPC。
- **上游提案（路径 B）**：preset 渠道挂 client 仍是真实生态需求，可以在社区反馈时
  引用本文第 2 节的扫描规则（相对 specifier 已可解析，缺的只是"preset 子树参与扫描"）。
