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
node test/smoke.mjs         # 插件：mock 注册表跑全部 52 个工具 + 输出 schema 校验
node test/svgpng.mjs        # 光栅化器：PNG 结构 + inflate 回像素断言 + 真实渲染器子集检查
node test/client.mjs        # 客户端产物：按加载器方式执行 + 面板数据通路（无浏览器）
node test/panel-render.mjs  # 面板组件：最小钩子宿主里跑真实组件（无 React、无 DOM）
node test/client-mount.mjs  # 客户端挂载：复刻宿主侧图扫描，核对 web profile 的行与依赖
node test/preset-health.mjs # 组合：逐行按该包自己的 Config schema 校验 preset 可挂载性
node test/drift-probe.mjs   # 组合漂移守卫：用变异组合证明 preset-health 的比对会失败
node test/preset-health.mjs preset/molbio-lab/agent.cordis.yml --dsh <harness 根目录>
node test/client-mount.mjs --profile web --dsh <harness 根目录>
```

`npm test` 依次跑这三组（`test:unit` = smoke + svgpng + 四个客户端套件，再 `contract`、
`drift-probe`、`preset-health`）。
脚本用 `node --run` 串联而不是裸 `&&`——`&&` 是 npm 的 shell 语法、不是 node 的，在 Windows
的 cmd/PowerShell 下 `npm test` 会失败。只想跑一半时：`node --run test:smoke` /
`node --run test:svgpng` / `node --run test:client`。

三个检查回答的是**不同**的问题，发布前都要跑：

- `smoke.mjs` 证明**插件**可用：mock 注册表运行全部 52 个工具，并用 harness 自身的
`assertSupportedJsonSchema` / `validateJsonSchemaValue` 校验每个输出 schema 与返回值；覆盖已知值用例（EcoRI 酶切、ΔΔCt=-3 → fold 8、GenBank/SnapGene 解析、引物对一致性、
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
排序不变式、九条参数/输入错误路径）、v17 TaqMan（固定切片上 7 条测定：逐条断言探针 = 模板切片或反向互补、不与任一引物重叠、`distance_from_primer_3prime` 正是从开缺口引物 3' 端量起、5'/3' 端非 G、无 run、Tm/GC 在窗口内；钉住排名第一的测定与一条"缺口在反向引物一侧"的测定；探针 Tm 与 `lib.primerTm` 同源；四条选项错误路径含嵌套 `primer_options`）、v17 多重 PCR（4 对真实引物的固定面板：24 条交互、3 条跨 target 二聚体与阈值、164 vs 168 bp 不可分辨 / 103 vs 83 bp close；相同模板不交叉 vs 不同模板共享 3' 尾判交叉；无坐标不出大小冲突；四条错误路径）、v17 蛋白图（14 残基两亲性肽的 μH/窗口最大/类别计数/单位圆坐标手算值；69 残基蛋白 GRAVY、三条峰、首窗口截断语义、窗口 21 平滑；SVG 逐字形与逐顶点断言；错误路径）、v17 甲基化与双酶切（手工夹具的 blocked/impaired/cuts/no_site 四态与片段算术、pUC118 全质粒 dam/dcm 计数、环状双酶切切点与片段、共用/不共用 buffer、两条易错建议、错误路径）、v18 图片交接（未传 `attach_image` 时**一个字节都不提交**、结果仍是单个 text block；传了以后提交的确实是 PNG（签名 + IHDR 尺寸与凝胶画布手算值一致）、结果多出 `image` 字段与第二个 image block；10 个画图工具逐个断言"有参数、有输出字段"，总数恰好 11；四条降级路径——文本路由、无附件服务、路由解析不出、存储拒收——都**不改结果成功性**、只在 `image_note` 里点名原因；`render` 在附加图片时仍产出文本）。

- `svgpng.mjs` 回答的是第三个正交问题：**工具算对了、但模型看到的图是不是对的**。纯文本正确
  而 PNG 空白/错位/无法解码，是唯一一类"其它套件全绿"的真故障，所以这层必须自己站住：
  测试用**与编码器不同实现**的 CRC（无表位运算）与裸 inflate 把字节解回像素，再做**手算几何**
  断言（rect 的四个边界像素、圆心与半径外、描边居中与 dash 空档、`fill-opacity` 混合到中灰、
  `fill="none"` 不填充、`text-anchor` start/middle/end 的墨迹框、cap height≈0.7 em、
  `dominant-baseline` 居中、`textLength` 压缩到指定宽度、`rotate(-90)` 把基线转到旋转点左侧
  并把运行变竖）；再对**四个真实渲染器的八份产物**断言 `unsupported` 与 `missing_glyphs`
  都为空、且有实质墨迹——新增 SVG 构造会在这里失败，而不是从图里静默消失。另有两个回归守卫：
  **线性质粒图谱**必须是 960×260 且 x≥880 有墨迹（v18 之前根 viewBox 固定 840×840，把 3' 端
  裁掉了——正是"给模型看图"这件事把该 bug 暴露出来），以及**光栅化器不得进入客户端产物**
  （它 import `node:zlib`，进 bundle 就会在浏览器里炸）。`--sheet <png>` 导出整张字形表、
  `--preview <dir>` 导出每种图各一张，供人眼复核字体（改字形后**必须**这样看一遍）。

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

- **v18 图片交接"没验证到"的那一环**（诚实清单）：已证明的是——附件服务能收下我们自己编码的
  PNG（`contract.mjs` 直接调 harness 的 `validateImageFile`/`prepareImageFile`，同一套生产
  解码/归一化代码，并且**故意损坏的 PNG 会被拒**，证明这道检查有效）；harness 自己的
  `read_image` 能把附件投影成模型可见的图片块（八份真实产物就是这么逐张人眼复核的，用的就是
  本机这条链路）。**尚未在真实会话里验证的**只有一步：本插件的工具结果数组被 harness 的
  工具层接收并落进会话事件（即"注册期之后就没人跑过"的那一步），它需要的条件是一次真实模型
  调用 + 分子生物学模式会话 + 图像输入模型。验证方法很直接：在 "Molecular Biology Lab" 模式里
  对 `molbio_virtual_gel(lanes=[...], attach_image=true)` 提一次，然后看会话事件里是否出现
  `{ type: 'image' }` 块、`image.attachment_id` 与附件目录里的对象是否对得上。

- `preset-health.mjs` 证明**组合**可挂载：它刻意与冒烟测试正交——preset 是 DSH
  **自己那些包**的组合，DSH 升级后如果某个包的 `Config` 契约变了（0.1.5-alpha.2 就
  把 `dsh-persona` 的 `text` 换成了 `prefix`/`suffix`），插件代码一行没错，preset 却会
  在挂载时抛 `$.prefix missing required value`，整个模式从选择器里消失。该脚本把组合的
  **每一行** config 交给那一行指向的包自己的 `Config` schema 校验（与 Loader 同一套
  判定，但不启动 harness），另加两项检查：行指向的模块是否存在（相对说明符按组合所在
  目录解析，与 Loader 改写 `baseUrl` 的行为一致）、行集合与官方 `standard` 预设的差异
  （缺行 = 悄悄丢能力，多行 = 本插件的 tool-molbio）。`disabled:` 行与 `!!js` 条件行按
  Loader 的规则跳过。退出码非 0 即发布阻断。
- **漂移检查是"逐行结构比对"，不是"比 id"**：`compositionDrift`（`preset-health.mjs` 导出）
  按**行序**比对 `id`、`name`、`disabled`、`isolate`、`config`，任何差异都是**发布阻断**。
  0.1.6-alpha.1 那次的教训是两件事同时发生而检查全瞎：组合里有一行指向
  **没有 DSH 发布的 `@deepseek-ai/dsh-workflow-worker-thread`**（preset 直接挂不上），
  以及 `tool-ralph` 被**悄悄启用**（上游 `standard` 是 `disabled: true`）。只比 id
  的旧检查只打印 "drift note" 并退出 0。允许清单只有 `ALLOWED_EXTRA_ROWS = {tool-molbio}`
  与（当前为空的）`ALLOWED_DISABLED_ROWS`，写在文件顶部。
- `drift-probe.mjs` 证明**上面那个守卫会响**：用变异组合（幻影 provider 行、丢掉的
  `disabled`、改名、改 config、改 isolate、丢行、多余行、行序错乱）驱动 `compositionDrift`，
  断言每一种都被抓到，并且对当前组合**零噪音**。"没人见过失败的守卫不算守卫"——旧检查
  之所以放过真故障，正是因为它从没被证明会失败。

## 发布与更新流程

### 发布前预检（0.7.1 事故之后加的硬步骤）

**任何**要 push 或打 tag 的版本，先跑完这三步，缺一步都不算发布完成：

```bash
npm test                     # 9 个套件（= test:unit(smoke+svgpng+4 客户端) + contract + drift-probe + preset-health）；
                             # 客户端半、光栅化器或 preset 组合的改动必须全绿
node build/client-bundle.mjs # 产物与源同一批构建（`--check` 只报告陈旧、不落盘）
git status --short           # lib/client.js 与 packages/molbio-panel/lib/client.js 不得是未提交状态
```

**preset 组合的改动**（`preset/molbio-lab/*`）额外一条：`node test/preset-health.mjs` 必须
报 `OK`，且 `git diff --no-index <安装的 standard> preset/molbio-lab/agent.cordis.yml` 只应剩
**末尾 `tool-molbio` 那一个 hunk**（加上文首"维护契约"注释）。吸收 DSH 升级时照抄上游文本
（含注释与 key 顺序），不要手写"看起来等价"的行——0.1.6-alpha.1 的
`workflow-worker-thread` 就是这么进去的。组合文件本身**不吃模块缓存**（每次挂载重读），
所以只改组合**不需要**新建 `vN` 目录。

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
`tool-molbio`（当前基线：**dsh 0.1.6-alpha.1**）。它不会自动跟随 DSH 升级，因此每次升级
DSH 后：

1. 取新版的 shipped `standard`：
   `<harness>/node_modules/@deepseek-ai/dsh-agent-presets/presets/standard/agent.cordis.yml`；
2. 与 `preset/molbio-lab/agent.cordis.yml` 做 `git diff --no-index`，**逐行吸收上游改动**
   （新增/删除的行、注释、key 顺序、配置契约变化），只保留 `tool-molbio` 这一处有意差异
   与头部注释。**照抄上游文本，不要手写"看起来等价"的行**——"注释也要抄"这条纪律的价值
   就是让上面这条 diff 恒为**一个 hunk**，从而能当漂移审计用；
3. 跑 `node test/preset-health.mjs` 直到 `OK`（它现在把任何结构差异当**发布阻断**，
   不只是打印 note）；
4. 更新组合头部"Baseline: …"那行里的 DSH 版本号；
5. **route-B（推荐渠道）用户不需要做任何事**：组合文件每次挂载重新读取，重启 profile 即可。
   仅"复制渠道"用户需要把新组合复制到 `~/.dsh/.agent-presets/molbio-lab/`
   （组合文件可直接覆盖，`plugins/` 里的 `vN` 目录不受影响）。

偏差的历史教训：

- 0.1.2 → 0.1.5 期间遗漏了 `persona` 的 `text → prefix/suffix` 契约变更，组合在
  0.1.5-alpha.2 上直接挂载失败；`present` 行也在同一时期丢失。
- 0.1.6-alpha.1：组合里的 `workflow-worker-thread` 指向**没有 DSH 发布过的包**，preset
  完全挂不上；同时 `tool-ralph` 被悄悄启用。两者都被旧版"只比 id"的 drift 检查放过
  （只打印 note、退出 0）。现已由**逐行结构比对（失败即阻断）** + `drift-probe.mjs` 看守。

## 路线图

- **先清障（已完成，包 0.9.1）**：DSH `0.1.6-alpha.1` 漂移修复——preset 组合
  指向不存在的 `workflow-worker-thread`（**预设挂不上**）已改为上游 `workflow-ptc`、
  `tool-ralph` 按上游 `disabled`、组合与上游逐行对齐；`preset-health` 的漂移检查升级为
  逐行结构比对并**阻断发布**；新增 `drift-probe.mjs` 证明该守卫会失败；`contract.mjs` 的
  hook-prop 断言不再绑定 minify 形态；产物新鲜度检查不再依赖 `spawnSync`（沙箱 EPERM 下
  也能验证），生成逻辑抽到 `build/client-bundle-core.mjs`。工具与 preset 目录未变
  （仍 52 / v17）。
- **v19（功能候选池，按需挑选）**：Cas12a/Cas13 等其他 PAM 家族（`pam` 参数已可传 `NNRT` 这类模式，缺的是家族特定的评分曲线与几何校验）；gRNA 的基因组级脱靶（当前实现把传入序列当参考，基因组规模需要先建一次索引再复用）；多重 PCR 的温度梯度/引物浓度配平建议；TaqMan 的 MGB/双标记探针变体与探针订购 CSV 直出。
  更宽的候选池与"为什么不做"的否定清单见 **[docs/capability-gap-survey.md](capability-gap-survey.md)**
  （40 条排序候选 + 必做 top-5，逐条标注是否需要外部二进制/参考库/网络与实现规模）；
  另有一个被 v18 明确留下的技术债候选：**若上游给 fs 缝加上二进制写入**（`contract.mjs` 里有一条
  断言专门盯着这件事），就补齐当年的 `png_path`（工作区 PNG 文件），见 README 的 `attach_image` 一节。
- **浏览器面板的候选（客户端半，不动 preset 目录）**：给 `molbio_sequence_logo` /
  `molbio_grna_design` 等工具加调用卡（同一套 `presentationMeta` + 卡片模式，上线前先跑
  `test/client.mjs` 的抢座位顺序那一层）；文献库写回需先定并发契约。

### DSH 0.1.6 新能力的可用性勘察（2026-09-16，只读；基线 dsh 0.1.6-alpha.1）

用户侧报告 0.1.6 带来"面板内终端"与"computer use"。逐包核对（README + `lib/types/*.d.ts` +
shipped bundle 的 `cordis.patch.yml` + 活动 profile 的 patch）后的结论，作为 v18 的输入：

| 能力 | 本版实际状态 | 对 molbio 的可复用性 |
| --- | --- | --- |
| 面板内终端（浏览器半：`dsh-api-terminal-controller` 的 `ctx.terminalController` + `dsh-client-ui-sidebar-terminal`） | **随 `dsh-web-app` 出厂即启用** | ✅ **已经在用，零改动**（见下） |
| 持久 shell（agent 半：`ctx.terminals` + `dsh-terminal-bash` + `dsh-tool-bash-persistent` / `dsh-tool-pwsh-persistent`） | 包已安装，**未被任何 web/standard 组合挂载** | ⚠️ 需要组合改动（见下） |
| Computer Use / Browser Use | **本版没有实现**：只有 `dsh-tool-cordis` 生成目录里的 `ctx.computerUse`/`ctx.browserUse` 接口描述、`dsh-system-prompt` 里无人消费的 `TOOL_COMPUTER_USE: 3000`、以及 `dsh-mcp-client` README 提到的未安装 "Cua Driver provider" | ❌ 不进预设（见下） |

**面板内终端与 molbio 面板已经共存，无需任何改动。** 两套东西同名不同源：浏览器终端是
**会话级、用户专用**的 Typert remote（`remote.terminal`：`environment/shells/list/create/
follow/write/resize/rename/close`，上限 8 个终端、scrollback 1000 行，**终端输出永不进入
agent 上下文**）；`ctx.terminals` 是**按 agent 做 owner 隔离**的持久 PTY。共存靠公开的
tab 注册 API：终端 `id = '@deepseek-ai/dsh-client-ui-sidebar-terminal'`、`kind: 'terminal'`、
guide order 20；本包 `id = 'dsh-molbio-tools'` / `'dsh-molbio-tools/papers'`、guide order 40/41。
**tab `id` 重复会抛异常**（本包那两个 id 的唯一性由 `test/client.mjs` 看守），因此不要改自己的 id。
用户因此今天就能在工作区里手跑 BLAST+/samtools/mafft/primer3/conda/`Rscript -e`，而 molbio 的产物
就在同一目录。

**v18 候选 1——让模型"看见"自己产出的图（已落地，但**换了机制**：附件而非 `png_path`）。**
`dsh-tool-fs` 自带模型可见的 **`read_image`** 工具（PNG/JPEG/WebP/GIF，按文件签名识别、可降采样）；
注册条件是挂了持久 `ctx.attachments` **且**当前路由模型的精确 id 声明了图像输入，否则该工具不注册。
本包所有绘图工具只写 SVG，而 `read_image` 不接受 SVG——这一步确实缺。

**但"新增 `png_path` 参数写一个 PNG 文件"这条路在本版 harness 上不可实现**，三层证据：
`dsh-fs/README.md` 写明 "*Text-only mutations by contract* — … **binary-safe mutations remain
deferred**"；`dsh-fs-local` 的 `writeText → writeFileAtomic` 把调用方的**字符串按 UTF-8 落盘**
（用 latin-1 夹带字节会被 UTF-8 编码器替换而损坏），文本读取还会以 `subarray(0, 8192).includes(0)`
拒收 NUL，**连读回都做不到**；全树检索**没有任何 `writeBytes`**，`FsErrorCode` 里只有 `FS_NOT_TEXT`。
绕开它有两条路，都**明确拒绝**：直接 `node:fs` 写、或用 `ctx.get('subprocess')` 起进程写盘——两者
都逃出"所有写入经 `ctx.fs` 并携带会话 sandboxPolicy"这条本包全程遵守的纪律（与文档里已记录的
MCP stdio server 不受沙箱约束是同一类问题）。

**落地的机制**：`ctx.attachments.saveImage({ data, mediaType })` 是 harness 提供的**二进制安全**
通路，而工具结果的 `output.render` 可以返回 **image content block**（`dsh-llm` 的 `ImageBlock =
{ type: 'image', attachment: ImageAttachmentRef }`）——这正是 `read_image` 自己用的那条路。于是
v18 给 11 个画图工具加了**可选** `attach_image: true`：工具把同一张图当场光栅化成 PNG（新模块
`svgpng.mjs`，零 npm 依赖、`node:zlib` 是内置模块）并提交为附件，结果里回一个 `image` 对象，模型
**直接看见图**，连一次 `read_image` 往返都不用。默认关（不传就没有任何行为变化）。

三条实现纪律：**能力门照抄 harness 的规则**（`exec.agent.session.requestHeader().config` →
provider/model → `ctx.get('llm').resolveModelInfo()` → `inputModalities.includes('image')`，与
`read_image` 的 `assertImageCapableRoute` 同源，`contract.mjs` 盯着它）；**永不失败**（图片是额外
好处：无附件服务/文本路由/渲染不了/存储拒收都降级为纯文本 + `image_note` 说明原因，SVG 照写、
调用照成功）；**渲染不了的要上报**（`unsupported`/`missing_glyphs` 计数，测试断言真实渲染器的
产物必须落在支持子集内）。

### v18 已完成（2026-09-17，包 0.10.0 / preset 目录 v18）

图片交接：`svgpng.mjs`（SVG 子集 → 光栅化 → 自写 PNG 编码：IHDR/IDAT/IEND + 自算 CRC32，
deflate 用内置 `node:zlib`；内置**折线字体**覆盖 ASCII 与 `· ° ± — – … ≈ μ α ─`；不支持的元素/
命令/画法一律**计数上报**）+ 11 个画图工具的 `attach_image`。顺带修掉一个真 bug：**线性质粒图谱
的根 viewBox 固定 `0 0 840 840`**，而 `renderLinear` 画到 x≈900——3' 端一直被裁掉（浏览器里同样
裁）；现在按拓扑选画布（960×260 / 840×840），`test/svgpng.mjs` 盯着 x≥880 必须有墨迹。工具仍
52 个。验证方式：像素用**独立实现**的 CRC + 裸 inflate 解回后手算断言；八份真实产物再经 harness
自己的图像解码器（`read_image`）**逐张人眼复核**（这是本项目第一次能"看着自己的产物"验证）。

**v18 候选 2——结构文件的浏览器内预览（客户端半）。**
`ctx.documentPreviews.register({ id, extensions, binaryExtensions?, priority, title, loading, wrap? })`
+ keyed `sidebar.right.tab.document` 座位，允许本包按**扩展名**注册自己的渲染器（`loading:
'bytes-complete'` 拿完整字节）。现有 Molbio 面板只处理 `.dna/.gb/.gbk/.fa/.fasta`；可以让
`.pdb/.cif/.sdf/.mol` 在工作区里点开就进本包自己的标签页。**必须诚实界定范围**：这里提供的是
**容器（座位 + 注册表 + 字节加载 + 渲染器选择）**，不是现成的 3D 查看器——v18 要么只做 2D 投影
（如 Cα 轨迹/二级结构条带），要么把"真正的 3D"单独估工并决定是否值得。座位与 `documentPreviews`
都走 `ctx.slots.inject`（0.7.1 的抢座位事故就是教训）。

**v18 候选 3——持久 shell 进 preset（收益有限、风险明确，需先验证）。**
要加的行：`@deepseek-ai/dsh-terminal` + `@deepseek-ai/dsh-terminal-bash` +
`@deepseek-ai/dsh-tool-pwsh-persistent`（Linux 用 `@deepseek-ai/dsh-tool-bash-persistent`）。
`sandbox` / `sandbox-policy` / `subprocess` **已在 `dsh-base`**，无需新增。两个硬约束：

1. **工具名冲突**：`dsh-tool-pwsh` 与 `dsh-tool-pwsh-persistent` 都注册 `pwsh`（`bash` 同理），
   必须把一次性那行 `disabled`，否则注册抛 "already registered"；这会让我们偏离上游 `standard`
   的逐行对齐，需要同步加进 `test/preset-health.mjs` 顶部的 `ALLOWED_DISABLED_ROWS` 并写进组合头部。
2. **唯一待验证点**：从 **preset**（不是 profile）发布服务需要一个 `isolate: { terminals: true }` 分组。
   机制在 shipped preset 里有先例（`planning`/`compaction`/`delegation` 都这么写），但**没有任何
   shipped preset 这样挂过 terminal**。验证方式：复制安装的 `standard`，加该分组与持久工具行、
   禁用一次性行，跑 `node test/preset-health.mjs`（逐行按安装包的 schema 校验）。

**对实验台的实际收益与边界**：cwd、环境变量、conda 环境、`samtools faidx` 索引跨调用存活，适合多步
CLI 流程；但 **Windows 上交互式 REPL 不可靠**（stdin 等待判定是启发式，会跑到 300 s 工具超时并
**重置 shell**），可靠写法是 `python -c` / `Rscript -e` 单行。另外 `ctx.terminals` 只能被**创建它的
那个 agent** 操作（`FOREIGN_SESSION`），本包的插件工具没有"替用户开终端标签页"的通路。

**明确不在本版、不要再重复勘察的能力（避免 v18 走错方向）**：

- **computer use 的任何 agent 侧能力**：无截图/鼠标/键盘工具，无 OS 辅助功能树读取，无 OCR，
  未安装 `dsh-computer-use`/`dsh-browser-use`/`cua-*`/`dsh-inspector`；全树 `screenshot` 只出现一次
  且是**否定句**（web 面提示词声明浏览器不提供 DOM/route/screenshot 上下文）。生态里确实存在
  官方实验包与社区插件（`ctx.computerUse` seam + `computer_*` 工具，需 `llm-pi-ai` 视觉路由、
  `attachment`、`credentials`、`user-approval`），但那是**装插件 + 改 profile patch**的用户选择，
  不进 Molecular Biology Lab 预设：它换不来计算能力，只换来操控网页/桌面（如网页版 Primer-BLAST、
  IDT 下单界面），却让"浏览器控制"与"实验记录"同处一个会话。
- **agent 驱动浏览器终端**：无 `dsh-tool-terminal`（该包未安装，故六个 `terminal_*` 工具不存在），
  且面板明确不把输出转给模型。`ctx.computerUse`/`ctx.browserUse` 这类 seam 只允许**一个** provider
  注册（重复注册即失败），所以第三方插件即便在未来版本也**不能**自带一个并行实现去抢。
- **MCP 与 hooks**（同批勘察）：`dsh-mcp-client` **未被任何 shipped bundle 挂载**（只有
  `dsh-mcp-resources` 在 `dsh-base`），用户要加需在 profile 的 `cordis.patch.yml` 写一行
  `name: '@deepseek-ai/dsh-mcp-client'`（MCP 工具名形如 `mcp__<server>__<tool>`，图像结果会经附件
  投影给模型）；宿主插件也可以在自己的 `apply` 里 `ctx.plugin(McpClient, config)` 程序化挂载
  （对象插件契约，**运行时未实测**）。**安全要点**：stdio MCP server 由 MCP SDK 自己 spawn，
  **不受 DSH 文件沙箱约束**，只做环境变量清理（`/KEY|PASSWORD|SECRET|TOKEN/i` 与 `DSH_*` 被丢弃）。
  `dsh-hooks-*` 是给已有 Claude Code / Codex `hooks.json` 的**兼容适配器**，不是插件扩展点——
  插件应直接监听 `tools/pre-execute` / `tools/post-execute` / `agent/pre-step` / `agent/turn-stopping`
  这些同名拦截点。这两项都不是 v18 必需，仅作为"若实验台要接外部计算服务"的备选记录在案。

- **v17 已完成（2026-09-13，包 0.9.0 / preset 目录 v17）**：TaqMan 水解探针设计（`taqman.mjs` + `molbio_design_taqman`）、多重 PCR 互扰检查（`multiplex.mjs` + `molbio_multiplex_check`）、甲基化敏感位点检查与双酶切 buffer 兼容（`methylation.mjs` + `molbio_methylation_check` / `molbio_double_digest`，参考表进 `lib.mjs`）、螺旋轮与疏水性图（`protein-structure.mjs` + `molbio_helical_wheel` / `molbio_hydropathy_plot`）。工具 46 → 52。实现过程中三次纠正探针几何、抓到 `primer_options` 全表静默失效与两处非 lossless-JSON 字段，详见 CHANGELOG 0.9.0。
- 质粒图谱的浏览器内实时面板（**已落地**：bundle 渠道——手写 lazy-CJS 打包器 + 右栏 Molbio 面板 + 图谱调用卡，见 `docs/client-panel.md`；v17 起 `browser-api.mjs` 也再导出 v17 的纯计算面，但面板未改动）
- 文献库的浏览器端面板（**已落地**：右栏 "Papers" 页）
- 向上游提议"preset 渠道挂 client"（探索文档路径 B）

## 已完成的方向（历史）

- **v18（2026-09-17，包 0.10.0 / preset 目录 v18）**：把画出来的图**交给模型看**——`svgpng.mjs`
  （零依赖 SVG 子集光栅化 + 自写 PNG 编码 + 内置折线字体）+ 11 个画图工具的可选 `attach_image`
  （附件而非文件：`ctx.attachments.saveImage` + 结果里的 image block，理由见上文三层证据）。
  工具仍 52。顺带修掉线性质粒图谱被根 viewBox 裁掉 3' 端的真 bug。
- **v17（2026-09-13，包 0.9.0 / preset 目录 v17）**：TaqMan 水解探针设计、多重 PCR 互扰检查、甲基化敏感位点与双酶切 buffer 兼容、螺旋轮与疏水性图。工具 46 → 52。
- **v16（2026-09-10，包 0.6.0 / preset 目录 v16）**：Sequence logo SVG（`logo.mjs` + `molbio_sequence_logo`，信息量 scaling 含小样本校正）+ CRISPR gRNA 设计（`crispr.mjs` + `molbio_grna_design`，双链 PAM 扫描、逐项公开的排序启发式、复用 v12 mispriming 的 k-mer 索引做错配容差脱靶搜索）。工具 44 → 46。
- **v15（2026-08-22，包 0.5.0 / preset 目录 v15）**：多序列比对（渐进仿射缺口 NW + UPGMA）与保守性分析。
- **v12–v14**：引物设计的 Primer3 对齐与错配容差；盐/浓度旋钮、Golden Gate、酶目录、虚拟凝胶；线粒体密码子与 Sanger/酶切几何修正 + auto-view。
