# 维护者文档（Maintainer Notes）

面向插件维护者与贡献者的内容；终端用户请阅读 [README](../README.md)。

## 与官方插件规范的对照

本插件受"零依赖、随 preset 分发"约束，注册**裸工具定义**（无法 import `defineTool`），
因此自行实现了官方约定中的等价行为，并逐项对照过
[官方插件开发指南](https://deepseek-harness.github.io/deepseek-harness/develop/basic/)：

- **参数校验**（对应 `defineTool` 的 `ToolArgsError`）：`execute` 前按 `parameters`
  schema 做通用校验（必填/类型/enum/嵌套结构），领域校验（IUPAC 合法性、坐标范围等）
  由各工具补充；
- **输出 schema**：全部通过 harness 自身的 enforced subset 校验；冒烟测试用
  `assertSupportedJsonSchema` / `validateJsonSchemaValue` 逐工具验证输出值与 schema，
  保证 lossless JSON；
- **并发安全**：纯计算/只读工具才声明 `isConcurrencySafe`；写文件/网络副作用工具声明
  false 或按参数条件声明——避免并发读改写 `papers.json` 等文件的竞态；
- **服务访问**：`inject` 仅用于硬依赖（`tools`/`systemPrompt`）；`web`/`fs`/
  `sandboxPolicy` 用 `ctx.get` + 存在性检查，缺失时明确报错而非崩溃；
- **文件与沙箱**：所有写入经 `ctx.fs` 并携带会话 `sandboxPolicy`，与官方 `tool-fs`
  模式一致；读取用 `readBytes` 带大小上限；
- **组合规则**：插件不发布任何服务（无需 isolate realm）；随 preset 挂载且
  `standingKeyFor` 校验通过；
- **prompt 段**：`ctx.systemPrompt.section` 注册在 100–199 工具指导区段（order 110），
  与官方 `tool-bash` 同模式。

已知的合理偏差（均已标注）：未提供 schemastery `Config`（无配置项）；错误类型为
`MolbioInputError extends Error`（零依赖无法 import `HarnessError`，语义上等价于参数/
输入错误）；未实现可选的 `presentCall`/`presentResult`。

### 自动查看（auto-view）

图片工具写完 SVG 后通过 `view.mjs` 直接调用操作系统默认应用打开（Windows
`Invoke-Item`、macOS `open`、桌面 Linux `xdg-open`/`$BROWSER`、WSL 经 `wslpath`
转译），镜像网关 `host.openPath` 的语义与 `canOpenNativePath` 的桌面可达性判定
（headless Linux 不 spawn；`MOLBIO_AUTO_VIEW=0` 全局关闭，冒烟测试依赖它避免
真实弹窗）。选择 OS 打开而非浏览器内嵌面板的原因：preset 插件无客户端打包管线，
无法挂客户端半（路线图中的浏览器内嵌面板仍保留）；opener 用可注入 `internals`
seam 保持可测。工具层暴露 `auto_view`（默认 true，逐调用可关）并回显
`auto_viewed`。

## 开发与测试

```bash
node test/smoke.mjs         # 插件：mock 注册表跑全部 46 个工具 + 输出 schema 校验
node test/client.mjs        # 客户端产物：按加载器方式执行 + 面板数据通路（无浏览器）
node test/panel-render.mjs  # 面板组件：最小钩子宿主里跑真实组件（无 React、无 DOM）
node test/client-mount.mjs  # 客户端挂载：复刻宿主侧图扫描，核对 web profile 的行与依赖
node test/preset-health.mjs # 组合：逐行按该包自己的 Config schema 校验 preset 可挂载性
node test/preset-health.mjs preset/molbio-lab/agent.cordis.yml --dsh <harness 根目录>
node test/client-mount.mjs --profile web --dsh <harness 根目录>
```

三个检查回答的是**不同**的问题，发布前都要跑：

- `smoke.mjs` 证明**插件**可用：mock 注册表运行全部 46 个工具，并用 harness 自身的
`assertSupportedJsonSchema` / `validateJsonSchemaValue` 校验每个输出 schema 与返回值；
覆盖已知值用例（EcoRI 酶切、ΔΔCt=-3 → fold 8、GenBank/SnapGene 解析、引物对一致性、
SVG 文件写入与无旋转标签断言、克隆模拟手算序列比对、合成 ABIF 夹具、环状参考跨原点
比对、蛋白 MW/pI/消光系数手算值、酶切规则（P 前不切）、100% 效率标准曲线、FASTA/FASTQ
统计与转换、pUC118 特征提取、efetch XML 解析、BibTeX 转义、协议/实验记录往返、文献库
增删改查往返、auto-view opener 平台门控与命令交接（internals seam，MOLBIO_AUTO_VIEW=0
防真实 spawn）、v12 错配容差（精确优先不劣化、无解→有解救援、双链错配映射不变式、
3' 关键区保护与放开、跨内含子 spliced/genomic 双坐标错配报告、参数校验错误路径）、
v12 Primer3 对齐结构筛查（self-any/self-end 比对分阈值 8.0/3.0 的已知值、8 bp GC 茎
发夹 >47 °C 与 4 bp 茎不触发的边界、G/C 二聚体 67 °C 在默认阈值被拒/放宽后恢复、
末 5 碱基 ΔG 与 GC 数、GC clamp 0-3 分级、mispriming 双区块模板的非特异位点报告与
max_sites 拒绝、primer_check 新增热力学字段）、v13 反应条件旋钮（conditions 回显、
高盐 Tm 上升的引擎级已知值、四参数范围校验）、v13 3' 目标位置偏好（双目标位点排名
收敛、target_distance 与两引物距离的最小值一致、跨内含子剪接坐标目标、越界报错）、
v13 酶目录（90+ 全表、BsaI 几何 (1/5)/4 bp 突出端/非回文、双链向切点 [8,12] 与
[21,7,4] 片段手算值、环状单切、未知酶报错）、v13 Golden Gate（裸载体加盒子 + 载体
带盒子两种模式：突出端唯一/非回文/非互补规则、订购片段与连接点序列一致、最终质粒
按环状旋转包含手算序列、恰好保留 2 个盒子位点、区域内特征丢弃/下游特征平移、
cassette 模式三片段组装、片段内部位点/非 IIS 酶/缺少盒子/裸载体已有位点/回文盒子
五条错误路径）、v13 虚拟凝胶（SVG 内容与 ladder 标注断言、100bp ladder、非整数与
超范围片段、非法 ladder 报错）、v15 多序列比对与保守性（两两已知值：全同 100%/
单替换 87.5%/仿射缺口单碱基插入选缺口不选错配、U 按 T 处理；三序列渐进比对——
替换 + 末端自由缺口的列数与末端悬挂确定性、同一输入两次输出完全一致；保守性
source=msa/alignment 双路径：共识/列 identity/熵打分手算值、全缺口列计保守、
可变位点列表、两两同一性统计、简并碱基 union 共识（A/C/G → V）、FASTA 输入与
比对后 FASTA 写出、五条错误路径与四条参数边界）、v16 序列标识图（手算列值：全保守列
2 bits／50-50 列 1 bit／75-25 列 1.1887 bits 与总 bits、小样本校正开/关的差异、
简并碱基按集合摊分（RR 对 RR = 2 bits，RR 对 RA = 2.19 bits 而非 3）、缺口列计数与
「频率只按残基」、SVG 的 `<title>` 逐列提示与**逐字形断言 font-size/textLength 不超列宽**、
四条错误路径）、v16 CRISPR gRNA（自建 53 bp 夹具上四个 PAM 位点的手算几何：正链
6-25/31-50、反链 13-32/32-51 的坐标与链向、反向链 protospacer 必须是 20 nt 且等于顶链
切片的反向互补、PAM 报在靶向链上、NN Tm 58.43 °C 与 self-any 5.5 已知值、
**2 错配脱靶的互查**（正向两次调用互相指认，mismatch_positions [4, 7]）、脱靶扣分
（92 vs 无搜索时的 100）、种子末端不错配约束、GC/poly-T/C-run 过滤与「放宽 gc_max 才能
救回」的对照夹具、max_guides 截断标志、CSV 列头与行数、图谱标注、pUC118 文件输入与
排序不变式、九条参数/输入错误路径）。

- `client.mjs` / `panel-render.mjs` / `client-mount.mjs` 证明**浏览器半**可用（这是与上面
  两者正交的第三个问题：工具对了、组合能挂，客户端产物仍可能加载不了）。`client.mjs` 在
  `vm` 里按加载器的方式执行产物（注册形状、id、**注册期零全局写入**），用桩 `require`
  物化它，对桩服务 `apply()`，再把面板数据通路跑在真实 pUC118 夹具上（记录字段与 Node
  工具逐字段一致）。`panel-render.mjs` 更进一步：**真实组件**在一个最小钩子宿主里跑完整
  状态机（无 React、无 DOM——harness 不带 React，浏览器里的 React 由 shell 播种），断言
  列表/图谱/特征表/logo/搜索/标签/空库/坏库/卸载中止这些用户可见结果；它抓到过三个真 bug。
  `client-mount.mjs` 读**真实 profile 的组合**（bundle 的 `insert:` 行，用 harness 自己的
  YAML 方言），对每行复刻宿主扫描（最近 `package.json` + `dsh.client` + `exports["./client"]`
  存在性），断言本包走的分支与线上客户端包相同、`dsh.client.inject` 声明的包都是 graph 行、
  产物的 `require` 全部有答案。**没验证到的**：运行时才回答的三件事（插槽注入的
  `sessionId`/`useSessions`、guide 胶囊、`workspaceFiles` 的 wire 形状），见
  `docs/client-panel.md` 第 5 节。

- `preset-health.mjs` 证明**组合**可挂载：它刻意与冒烟测试正交——preset 是 DSH
  **自己那些包**的组合，DSH 升级后如果某个包的 `Config` 契约变了（0.1.5-alpha.2 就
  把 `dsh-persona` 的 `text` 换成了 `prefix`/`suffix`），插件代码一行没错，preset 却会
  在挂载时抛 `$.prefix missing required value`，整个模式从选择器里消失。该脚本把组合的
  **每一行** config 交给那一行指向的包自己的 `Config` schema 校验（与 Loader 同一套
  判定，但不启动 harness），另加两项检查：行指向的模块是否存在（相对说明符按组合所在
  目录解析，与 Loader 改写 `baseUrl` 的行为一致）、行集合与官方 `standard` 预设的差异
  （缺行 = 悄悄丢能力，多行 = 本插件的 tool-molbio）。`disabled:` 行与 `!!js` 条件行按
  Loader 的规则跳过。退出码非 0 即发布阻断。

## 发布与更新流程

### 发布前预检（0.7.1 事故之后加的硬步骤）

**任何**要 push 或打 tag 的版本，先跑完这三步，缺一步都不算发布完成：

```bash
npm test                     # 7 个套件；客户端半的改动必须全绿
node build/client-bundle.mjs # 产物与源同一批构建
git status --short           # lib/client.js 与 packages/molbio-panel/lib/client.js 不得是未提交状态
```

客户端半的改动还有两条**专门针对"会弄坏 GUI"**的确认：

1. **产物已构建且已提交**——profile 与 `dsh plugin add` 消费的是**产物**：源码改了而产物没
   重建，用户加载的还是旧逻辑；产物没提交，别人装到的就是旧逻辑。
2. **安装态与产物一致**（profile 用 junction 指向工作区时，这一步等于自查）：

   ```powershell
   (Get-FileHash packages\molbio-panel\lib\client.js).Hash -eq `
   (Get-FileHash $env:USERPROFILE\.dsh\profiles\<profile>\node_modules\dsh-molbio-panel\lib\client.js).Hash
   ```

   哈希不一致 = 你验证的和用户加载的不是同一个东西。

**回归防线的层次**（哪一层先响，决定排查方向）：`test/client.mjs` 在**运行时语义**上响
（座位抢注、产物格式、数据通路）；`test/contract.mjs` 在**DSH 契约**上响（官方是否改了规则或
API）；`test/slots-stub.mjs` 是前者的地基（复刻 shell 的 SlotCore 守卫与 `inject` 语义）。
只有两层都绿才 push。

### 客户端产物（browser half）

浏览器半由 `build/client-bundle.mjs` 从**包根的同一份 `.mjs` 源文件**生成到
`lib/client.js`，并同时为面板专用包产出
`packages/molbio-panel/lib/client.js`。改完源码后：

```bash
node build/client-bundle.mjs     # 或 npm run build:client
node test/client.mjs && node test/panel-render.mjs && node test/map-card.mjs && node test/client-mount.mjs && node test/contract.mjs
```

### 工具调用卡（`tool.call.toolview`）

卡片的数据只能走一条路：工具在 `output.presentationMeta(args, value)` 里声明投影，工具层
**对 ROOT 调用**执行它并把结果记进会话事件，浏览器把它作为 tool-result 块的 `block.meta`。
不要用 `presentResult`/`presentCall`——`dsh-tools` 的文档写明内置 Web 客户端不消费它们。
两条实现纪律：投影**必须廉价且不抛**（它跑在调用成功之后，抛错会把这次调用标成失败；
图谱标记因此走一份有界内存缓存而不是读文件），卡片**必须校验而非信任** meta（缺失/异种/
异形/超限/失败一律降级为提示，绝不在对话里抛错）。新增卡片时：把工具名加进
`build/client-entry.mjs` 的 `MAP_TOOL_KEYS`，并在 `test/map-card.mjs` 里补一条跨界断言。
另注意 `define()` 包装器会转发 `presentationMeta`——若哪天再包一层，别忘了这条。

三条纪律：**产物必须与源一起提交**（`dsh plugin add` 装的是产物，用户机器上没有构建
步骤）；**发布白名单必须覆盖产物所在目录**（`lib/`、`packages/`——`npm publish` 只带
`files` 列出的东西，漏了就会出现"装完却没有面板"的静默失败，`test/contract.mjs` 的
打包检查专门盯着这一条）；**产物不能进 preset 的版本目录**——客户端模块靠 `rev` 哈希
失效，与"版本目录规则"无关（那条规则只约束被 `import()` 的宿主侧 `.mjs`）。

**第四条纪律（0.7.2 用一次 GUI 起不来换来）**：客户端座位一律
`ctx.effect(() => ctx.slots.inject(座位, () => ctx.slots.register({name: 座位, …}, 组件)), 标签)`，
**绝不裸 `slots.register`**。座位只有在**拥有它的 entry 在自己的 `children` 表里声明之后**才
存在（`sidebar.right.pane.tab` ← 右栏 `rightbar.session`；`tool.call.toolview` ← ui-tool 的
`conversation.chat.node` 的**子座位**），而本包与那些包的 entry 之间没有顺序保证；裸 `register`
抛出的 `slot "…" is not declared (a parent entry's children table must declare it)` 从 `apply()`
逃出就是**加载器 entry 失败**——HARNESS "Failed to load plugins"，整个 Web GUI 不启动。
`test/slots-stub.mjs`（SlotCore 语义的桩）与 `test/client.mjs`（从"零座位已声明"启动）在运行时
看守这条纪律，`test/contract.mjs` 第 10 项再看守"产物里每一处 `register` 都在 `inject` 里"。

客户端通道的发布面：根包（工具 + 面板）与 `packages/molbio-panel`（只面板）是两个独立
条目，后者从它自己的目录发布（`npm publish packages/molbio-panel`）。

**安装与修复**：把面板装进某个 profile 只有一条正路——

```bash
dsh plugin --profile <profile> add <仓库路径>/packages/molbio-panel
```

profile 用的是 pnpm 的 **hoisted** linker，而 `link:` 依赖的软链**只由 `add` 物化**：
如果 `node_modules/<包>` 丢了（被清理、被误删、或 profile 目录被其它操作动过），
`dsh plugin --profile <profile> install` 与 `pnpm install --force` 都只会回答
"Already up to date" 而**不会重建链接**。修复办法就是重新 `add` 一次同一个路径（无需网络，
package.json 与 lockfile 里的声明不变）。装完核对三件事：链接存在、`package.json` 里
`dsh.client.platform === "web"`、`lib/client.js` 存在且与仓库产物同哈希。

**UI 起不来（`Failed to load plugins`）的排查顺序**：顶栏这条横幅 + 
`failed to apply loader entry <id> (<name>): <message>` 说明某个**客户端 entry 的 `apply()` 抛了
异常**，加载器拒绝 boot——不是"面板没挂上"。先止血：`dsh plugin --profile <profile> remove
<包>`（或从 profile 的 `dsh.profile.bundles` 里去掉那一行）后重启。定位：

1. `node test/client.mjs`——抢座位的顺序那一层会当场复现"未声明座位 `register()`"这类错误
   （0.7.1 → 0.7.2 就是这么被测出来的：`slot "tool.call.toolview" is not declared (a parent
   entry's children table must declare it)`）；
2. `node test/contract.mjs`——判断是 DSH 动了契约（slots 服务没了 `inject`、座位不再由同一条
   entry 声明）还是本包写错；
3. 改 `build/client-entry.mjs` → `node build/client-bundle.mjs` → 重启：**产物不重新构建就
   没有任何效果**（浏览器拿的是 `lib/client.js`，按 `rev` 哈希失效）。

preset 渠道（受 ESM 模块缓存约束）：

1. 修改包根代码并跑 `node test/smoke.mjs`（插件）与 `node test/preset-health.mjs`（组合）；
2. **只在插件 `.mjs` 有改动时**才新建版本目录：把 `.mjs` 文件复制进
   `preset/molbio-lab/plugins/dsh-molbio-tools-vN/`（绝不在已发布目录里原地改文件），
   并同步修改 `preset/molbio-lab/agent.cordis.yml` 的插件行目录名。
   只改 `agent.cordis.yml` / `preset.yml` / 文档时**不需要**新目录——组合文件每次挂载
   都重新读取，模块缓存规则只约束被 `import()` 的 `.mjs`；
3. 更新 `CHANGELOG.md`（包版本 ↔ 版本目录对照）并把 `package.json` 的 `version` bump；
4. commit + push，然后打**带日期的注释 tag**（仓库用 `v<包版本>`，如 `v0.5.1`）：

   ```bash
   git tag -a v0.5.1 -m "v15 (preset dir dsh-molbio-tools-v15): ..." && git push origin v0.5.1
   ```

   bundle 渠道天然免疫模块缓存（每个发布版本在 node_modules 中都是独立目录）。

### preset 组合的维护（DSH 升级后必做）

`preset/molbio-lab/agent.cordis.yml` 是官方 `standard` 预设的副本 + 末尾一行
`tool-molbio`。它不会自动跟随 DSH 升级，因此每次升级 DSH 后：

1. 取新版的 shipped `standard`：
   `<harness>/node_modules/@deepseek-ai/dsh-agent-presets/presets/standard/agent.cordis.yml`；
2. 与 `preset/molbio-lab/agent.cordis.yml` 做 `git diff --no-index`，**逐行吸收上游改动**
   （新增/删除的行、配置契约变化），只保留 `tool-molbio` 这一处有意差异与头部注释；
3. 跑 `node test/preset-health.mjs` 直到全部 `ok`（drift 里只应剩
   `extra row "tool-molbio"`）；
4. 把新组合复制到用户的 `~/.dsh/.agent-presets/molbio-lab/`（组合文件可直接覆盖）。

偏差的历史教训：0.1.2 → 0.1.5 期间遗漏了 `persona` 的 `text → prefix/suffix` 契约变更，
组合在 0.1.5-alpha.2 上直接挂载失败；`present` 行也在同一时期丢失。两处都已修复，
并由 `preset-health.mjs` 看守。

## 路线图

- **v17（候选池，按需挑选）**：TaqMan 水解探针设计；多重 PCR 互扰检查；蛋白螺旋轮投影图（helical wheel）；疏水性窗口图（hydropathy plot，Kyte-Doolittle）；甲基化敏感位点（dam/dcm/EcoKI）与双酶切 buffer 兼容提示；Cas12a/Cas13 等其他 PAM 家族（`pam` 参数已可传 `NNGRRT` 这类模式，缺的是家族特定的评分曲线与几何校验）；gRNA 的基因组级脱靶（当前实现把传入序列当参考，基因组规模需要先建一次索引再复用）
- 质粒图谱的浏览器内实时面板（**已开工**：bundle 渠道的第一段已落地——手写 lazy-CJS
  打包器 + 右栏 Molbio 面板，见 `docs/client-panel.md`；待办：真机确认渲染、
  `tool.call.toolview` 自定义调用卡、以及第二个面板）
- 文献库的浏览器端面板（同上；0.1.5 起落点为右栏 tab 的 "Papers" 页或 `conversation.view`；
  数据面需先定：宿主 Typert RPC 还是把 `papers.json` 当普通文件读写）
- 向上游提议"preset 渠道挂 client"（探索文档路径 B）

## 已完成的方向（历史）

- **v16（2026-09-10，包 0.6.0 / preset 目录 v16）**：Sequence logo SVG（`logo.mjs` + `molbio_sequence_logo`，信息量 scaling 含小样本校正）+ CRISPR gRNA 设计（`crispr.mjs` + `molbio_grna_design`，双链 PAM 扫描、逐项公开的排序启发式、复用 v12 mispriming 的 k-mer 索引做错配容差脱靶搜索）。工具 44 → 46。
- **v15（2026-08-22，包 0.5.0 / preset 目录 v15）**：多序列比对（渐进仿射缺口 NW + UPGMA）与保守性分析。
- **v12–v14**：引物设计的 Primer3 对齐与错配容差；盐/浓度旋钮、Golden Gate、酶目录、虚拟凝胶；线粒体密码子与 Sanger/酶切几何修正 + auto-view。
