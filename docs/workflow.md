# 开发与发布工作流（Workflow）

本文是**怎么做**：测试金字塔各层回答什么问题、客户端半与 preset 怎么改、
发布前跑什么、npm 怎么发。**不能违反的硬规则**见 [rules.md](rules.md)，
版本历史见 [history.md](history.md)，未来方向见 [roadmap.md](roadmap.md)。

终端用户请看 [README](../README.md)。

---

## 1. 测试金字塔：每一层回答一个不同的问题

三层不是"更多测试"，而是三个**正交**的问题。任何一层全绿都不能推出另一层：

| 层 | 问题 | 谁回答 |
| --- | --- | --- |
| 插件 | 工具算得对吗？ | `test/smoke.mjs` |
| 画面 | 模型看到的图是对的吗？ | `test/svgpng.mjs` / `test/svgio.mjs` / `test/charts.mjs` |
| 组合 | 这套东西挂得上吗？ | `test/contract.mjs` / `test/preset-health.mjs` / `test/client*.mjs` |
| 使用 | 模型找得到、用得对吗？ | `benchmark/`（见 [benchmark/README.md](../benchmark/README.md)） |

```bash
node test/smoke.mjs         # 插件：mock 注册表跑全部 60 个工具 + 输出 schema 校验
node test/svgpng.mjs        # 光栅化器：PNG 结构 + inflate 回像素断言 + 真实渲染器子集检查
node test/svgio.mjs         # 共享绘图助手：几何手算值 + 每种助手拼一张文档后光栅化必须干净
node test/charts.mjs        # 图表：CSV/TSV 读取层 + 八种图表（含色带）的统计量与光栅化
node test/client.mjs        # 客户端产物：按加载器方式执行 + 面板数据通路（无浏览器）
node test/panel-render.mjs  # 面板组件：最小钩子宿主里跑真实组件（无 React、无 DOM）
node test/map-card.mjs      # 图谱调用卡：跨界 meta 投影断言
node test/client-mount.mjs  # 客户端挂载：复刻宿主侧图扫描，核对 web profile 的行与依赖
node test/contract.mjs      # DSH 契约：官方是否改了规则或 API
node test/preset-health.mjs # 组合：逐行按该包自己的 Config schema 校验 preset 可挂载性
node test/drift-probe.mjs   # 组合漂移守卫：用变异组合证明 preset-health 的比对会失败
node test/release.mjs       # 发布守卫：tag/版本/CHANGELOG/清单字段/tar 读取的决定函数（见第 4 节）
node test/benchmark-profile.mjs  # benchmark 的 headless profile 是否仍与 preset 逐行一致
node benchmark/run.mjs --offline # benchmark 的期望值是否仍等于工具的真实（渲染）输出
```

`npm test` 依次跑全部套件（`test:unit` = smoke + svgpng + svgio + 四个客户端套件，
再 `contract`、`drift-probe`、`preset-health`、`release`、`benchmark-profile`、`bench:offline`）。
脚本用 `node --run` 串联而不是裸 `&&`——`&&` 是 npm 的 shell 语法、不是 node 的，
在 Windows 的 cmd/PowerShell 下 `npm test` 会失败。

只想跑一半时：`node --run test:smoke` / `test:svgpng` / `test:svgio` / `test:client` /
`test:preset` / `test:release` / `test:benchmark-profile` / `bench:offline`。

**需要真实模型、因而不在 `npm test` 里的**：`npm run bench`（见
[benchmark/README.md](../benchmark/README.md)）。它花钱、且会随模型更新而变化，
所以它是**测量**而不是门禁；但它的**期望值**由上面那两道离线门看住。

### 各套件到底在防什么

- **`smoke.mjs`** 证明**插件**可用：mock 注册表运行全部 60 个工具，并用 harness 自身的
  `assertSupportedJsonSchema` / `validateJsonSchemaValue` 校验每个输出 schema 与返回值；
  覆盖已知值用例（EcoRI 酶切、ΔΔCt=-3 → fold 8、GenBank/SnapGene 解析、引物对一致性、
  SVG 文件写入与无旋转标签断言、克隆模拟手算序列比对、合成 ABIF 夹具、环状参考跨原点
  比对、蛋白 MW/pI/消光系数手算值、酶切规则（P 前不切）、100% 效率标准曲线、FASTA/FASTQ
  统计与转换、pUC118 特征提取、efetch XML 解析、BibTeX 转义、协议/实验记录往返、文献库
  增删改查往返、auto-view opener 平台门控与命令交接（internals seam，`MOLBIO_AUTO_VIEW=0`
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
  排序不变式、九条参数/输入错误路径）、v17 TaqMan（固定切片上 7 条测定：逐条断言探针 =
  模板切片或反向互补、不与任一引物重叠、`distance_from_primer_3prime` 正是从开缺口引物
  3' 端量起、5'/3' 端非 G、无 run、Tm/GC 在窗口内；钉住排名第一的测定与一条"缺口在反向
  引物一侧"的测定；探针 Tm 与 `lib.primerTm` 同源；四条选项错误路径含嵌套
  `primer_options`）、v17 多重 PCR（4 对真实引物的固定面板：24 条交互、3 条跨 target
  二聚体与阈值、164 vs 168 bp 不可分辨 / 103 vs 83 bp close；相同模板不交叉 vs 不同模板
  共享 3' 尾判交叉；无坐标不出大小冲突；四条错误路径）、v17 蛋白图（14 残基两亲性肽的
  μH/窗口最大/类别计数/单位圆坐标手算值；69 残基蛋白 GRAVY、三条峰、首窗口截断语义、
  窗口 21 平滑；SVG 逐字形与逐顶点断言；错误路径）、v17 甲基化与双酶切（手工夹具的
  blocked/impaired/cuts/no_site 四态与片段算术、pUC118 全质粒 dam/dcm 计数、环状双酶切
  切点与片段、共用/不共用 buffer、两条易错建议、错误路径）、v18 图片交接（未传
  `attach_image` 时**一个字节都不提交**、结果仍是单个 text block；传了以后提交的确实是
  PNG（签名 + IHDR 尺寸与凝胶画布手算值一致）、结果多出 `image` 字段与第二个 image
  block；10 个画图工具逐个断言"有参数、有输出字段"，总数恰好 11；四条降级路径——文本
  路由、无附件服务、路由解析不出、存储拒收——都**不改结果成功性**、只在 `image_note`
  里点名原因；`render` 在附加图片时仍产出文本）、v19 实验台五件套（FASTQ：8 条读夹具的
  逐位置均值/**线性插值四分位**/Q20-Q30/精确重复率/接头命中位置/过度代表序列的"小样本
  合法为空"与"24/30 命中"两侧；密码子：CAI 全最优 = 1、**家族大小必须从完整频率表来**
  （9 选 3 会让 GCT 的 CAI 从 1.0 变成 0.4444，这是实现时抓到的真 bug）、RSCU 家族和为
  家族大小、Nc/GC3/GC123 已知值、CpG obs/exp、五条警告路径、未知宿主由 enum 拦下；
  系统发生：p-distance 逐格手算、JC 校正值、**饱和夹取与上报**、逐对跳过缺口、
  **四点条件**钉住无根拓扑、UPGMA 与 NJ 输出确实不同、Newick 往返与四种非法输入的报错、
  同种子逐字节复现、bootstrap 预算按 replicates×pairs×columns 拒绝；PCR：产物坐标与序列
  逐字符、中段错配默认拒绝/放宽接受、**3' 端错配在 anchor=3 被拒而在 anchor=0 被接受**、
  错引导双带、大小窗口过滤计数、环状跨 origin 的取模切片序列、FASTA 输入与 8 条错误路径；
  组成：岛边界与长度手算、Takai 口径下同序列不出岛、**高 GC 但无 CpG 不算岛**、G/C 富集
  等长段的 ±0.5 skew 与 ori/ter 窗口、熵/复杂度/N50 手算值、同聚物不除零、窗口与 step
  计数、5 条参数错误路径）、**v20 比对残基守恒**（多组不等长输入逐条断言"输出行去缺口后
  逐字符等于输入序列"——11/10、12/10、不等长多序列、4/4 无重叠、前导悬垂、5/10 单侧全
  悬垂；所有行等长；以及**用一个故意截断的行驱动 `coverageShortfall`**，断言它仍报
  `u2 (10 of 11 bases kept)`，否则"没有警告"什么也证明不了）、**0.19.0 比对后处理**
  （手工 fixture 上四件事一次钉住：共识三种口径 —— `plurality`/`union` 给并集码、
  `strict` 给 N、平票取字母序首个；修剪阈值与覆盖阈值**互相独立** —— 0.6 的缺口列被修剪而
  0.4 的不被、0.8 的覆盖列被标记而正好 0.8 的不被；同一性矩阵**排除双缺口列**的 66.67 与
  `molbio_conservation` 同一对序列的 40 并排钉住，两个工具的均值 37.17% 与 32% 也一起钉，
  防止两套口径悄悄合并；超 50 条时矩阵改为省略而非截断且摘要仍覆盖每一对；
  10 条错误路径）。

- **`svgpng.mjs`** 回答第三个正交问题：**工具算对了、但模型看到的图是不是对的**。纯文本
  正确而 PNG 空白/错位/无法解码，是唯一一类"其它套件全绿"的真故障，所以这层必须自己站住：  测试用**与编码器不同实现**的 CRC（无表位运算）与裸 inflate 把字节解回像素，再做**手算
  几何**断言（rect 的四个边界像素、圆心与半径外、描边居中与 dash 空档、`fill-opacity`
  混合到中灰、`fill="none"` 不填充、`text-anchor` start/middle/end 的墨迹框、cap
  height≈0.7 em、`dominant-baseline` 居中、`textLength` 压缩到指定宽度、`rotate(-90)`
  把基线转到旋转点左侧并把运行变竖）；再对**四个真实渲染器的八份产物**断言 `unsupported`
  与 `missing_glyphs` 都为空、且有实质墨迹——新增 SVG 构造会在这里失败，而不是从图里静默
  消失。另有两个回归守卫：**线性质粒图谱**必须是 960×260 且 x≥880 有墨迹（v18 之前根
  viewBox 固定 840×840，把 3' 端裁掉了——正是"给模型看图"这件事把该 bug 暴露出来），以及
  **光栅化器不得进入客户端产物**（它 import `node:zlib`，进 bundle 就会在浏览器里炸）。
  `--sheet <png>` 导出整张字形表、`--preview <dir>` 导出每种图各一张，供人眼复核字体
  （改字形后**必须**这样看一遍）。

  **v20 给这层加了 `<tspan>` 多行文本的像素断言**（18 → 22 项）：三行 `<tspan>` 必须各自
  落在自己的基线上、**行间是空的**（塌到一条基线上会失败）；`dy` 相对堆叠逐级下移、
  **相邻基线之间空着**（证明是移动而不是重印）；自闭合空 `<tspan dy/>` 推进一个空行；
  `<tspan>` 的 `transform` 与嵌套 `<tspan>` 被**报告**而不是猜着画。最后一条是本次修复的
  **图像回归守卫**：长叶名的树图，在标签列里数"密集行"，断言每个名字至少两行、4 个标签
  块之间**至少 3 处空白间隔**——v19 的单行长标签会把这个数字压到 0 或 1。扫描区间从文档里
  **读出**（第一个 `<tspan>` 的 `x`），因为靠猜会把分支尖端、支持度和标题都算成"标签行"。

- **`client.mjs` / `panel-render.mjs` / `map-card.mjs` / `client-mount.mjs`** 证明**浏览器半**
  可用（这是与上面两者正交的第三个问题：工具对了、组合能挂，客户端产物仍可能加载不了）。
  `client.mjs` 在 `vm` 里按加载器的方式执行产物（注册形状、id、**注册期零全局写入**），用桩
  `require` 物化它，对桩服务 `apply()`，再把面板数据通路跑在真实 pUC118 夹具上（记录字段与
  Node 工具逐字段一致）。`panel-render.mjs` 更进一步：**真实组件**在一个最小钩子宿主里跑完整
  状态机（无 React、无 DOM——harness 不带 React，浏览器里的 React 由 shell 播种），断言
  列表/图谱/特征表/logo/搜索/标签/空库/坏库/卸载中止这些用户可见结果；它抓到过三个真 bug。
  `client-mount.mjs` 读**真实 profile 的组合**（bundle 的 `insert:` 行，用 harness 自己的
  YAML 方言），对每行复刻宿主扫描（最近 `package.json` + `dsh.client` + `exports["./client"]`
  存在性），断言本包走的分支与线上客户端包相同、`dsh.client.inject` 声明的包都是 graph 行、
  产物的 `require` 全部有答案。**没验证到的**：运行时才回答的三件事（插槽注入的
  `sessionId`/`useSessions`、guide 胶囊、`workspaceFiles` 的 wire 形状），见
  [client-panel.md](client-panel.md) 第 5 节。

- **`contract.mjs`** 盯的是**DSH 契约**：官方是否改了规则或 API。它直接调 harness 自己的
  `validateImageFile` / `prepareImageFile`（同一套生产解码/归一化代码，并且**故意损坏的 PNG
  会被拒**，证明这道检查有效），并看守"产物新鲜度""打包白名单""产物里每一处 `register`
  都在 `inject` 里"这些纪律。

- **`preset-health.mjs`** 证明**组合**可挂载：它刻意与冒烟测试正交——preset 是 DSH
  **自己那些包**的组合，DSH 升级后如果某个包的 `Config` 契约变了（0.1.5-alpha.2 就
  把 `dsh-persona` 的 `text` 换成了 `prefix`/`suffix`），插件代码一行没错，preset 却会
  在挂载时抛 `$.prefix missing required value`，整个模式从选择器里消失。该脚本把组合的
  **每一行** config 交给那一行指向的包自己的 `Config` schema 校验（与 Loader 同一套
  判定，但不启动 harness），另加两项检查：行指向的模块是否存在（相对说明符按组合所在
  目录解析，与 Loader 改写 `baseUrl` 的行为一致）、行集合与官方 `standard` 预设的差异
  （缺行 = 悄悄丢能力，多行 = 本插件的 tool-molbio）。`disabled:` 行与 `!!js` 条件行按
  Loader 的规则跳过。退出码非 0 即发布阻断。

- **`drift-probe.mjs`** 证明**上面那个守卫会响**：用变异组合（幻影 provider 行、丢掉的
  `disabled`、改名、改 config、改 isolate、丢行、多余行、行序错乱）驱动 `compositionDrift`，
  断言每一种都被抓到，并且对当前组合**零噪音**。"没人见过失败的守卫不算守卫"——旧检查
  之所以放过真故障，正是因为它从没被证明会失败。

### 工具数声明比对与逐行结构比对

- **工具数声明比对**：`preset.yml` 的描述里写着"57 个 molbio_\* 工具"，而 v19 从 52 加到 57
  时**漏改了它**——用户在整个 v19 周期看到的是错的数字，且没有任何检查会发现。
  `toolCountDrift(description, registered)` 把**预设真正加载的那个入口模块**里注册的工具数
  与描述里的数字对比。解析刻意窄（`<n> 个 molbio_*` 与英文 `<n> tools`），所以
  `90+ 限制酶`、`2–50 条序列`这类其它数字不会被误判；没有工具数描述的文案也不会被逼着加
  一个。与 `compositionDrift` 一样导出给 `drift-probe.mjs` 用变异输入驱动。
  `test/benchmark-profile.mjs` 把同一条比对也跑一遍（防止 benchmark 的 profile 与
  `preset.yml` 的声明脱节）。
- **漂移检查是"逐行结构比对"，不是"比 id"**：`compositionDrift`（`preset-health.mjs` 导出）
  按**行序**比对 `id`、`name`、`disabled`、`isolate`、`config`，任何差异都是**发布阻断**。
  0.1.6-alpha.1 那次的教训是两件事同时发生而检查全瞎：组合里有一行指向
  **没有 DSH 发布的 `@deepseek-ai/dsh-workflow-worker-thread`**（preset 直接挂不上），
  以及 `tool-ralph` 被**悄悄启用**（上游 `standard` 是 `disabled: true`）。只比 id
  的旧检查只打印 "drift note" 并退出 0。允许清单只有 `ALLOWED_EXTRA_ROWS = {tool-molbio}`
  与（当前为空的）`ALLOWED_DISABLED_ROWS`，写在文件顶部。

### 回归防线的层次

**哪一层先响，决定排查方向**：

1. `test/client.mjs` 在**运行时语义**上响（座位抢注、产物格式、数据通路）；
2. `test/contract.mjs` 在**DSH 契约**上响（官方是否改了规则或 API）；
3. `test/slots-stub.mjs` 是第 1 层的地基（复刻 shell 的 SlotCore 守卫与 `inject` 语义）。

只有都绿才 push。

---

## 2. 改动 ↔ benchmark：什么时候必须跑，什么时候不必

**规则：新增或改动任何工具行为，必须新增/更新对应的 benchmark 任务并重跑；没有改动就不必重跑。**

benchmark 不是"每天跑一遍"的门禁，而是**行为的验收测试**——它花真实 tokens，所以只在行为
变化时跑。判断依据是"这次改动会不会改变某个任务观察到的输出"：

| 这次改了什么 | benchmark 要不要动 | 为什么 |
| --- | --- | --- |
| 新增一个工具 | **必须**：加任务 + `verifications.mjs` 的 invocation | `test/benchmark-coverage.mjs` 会**直接 FAIL**（`60/60 tools covered` 是断言） |
| 改工具的参数、默认值、输出字段、渲染文本 | **必须**：更新受影响任务的断言，重跑 `--offline`，再重跑该任务 | 断言比对的是**渲染文本**，改了文本就改了对错 |
| 改工具的描述或参数说明（prompt 面） | **必须**：重跑对应任务 | 这正是 benchmark 唯一能测的东西——模型是否还选得对 |
| 改 `preset/molbio-lab/agent.cordis.yml`（行清单） | **必须**：先 `node test/benchmark-profile.mjs`，再重建 profile | 行清单变了，benchmark 的 headless profile 是**推导**出来的，守卫会 FAIL |
| 改 `lib.mjs` 这类同时属于浏览器半的模块 | 看影响：若改变了某个工具的输出 → 必须；仅内部重构 → 不必 | 判据仍是"任务观察到的文本会不会变" |
| 改文档、注释、`CHANGELOG` | **不必** | 不改变任何任务观察到的输出 |
| 改客户端半（`build/`、`lib/client.js`） | **不必** | benchmark 不加载客户端产物 |
| 改测试、CI、`.gitignore` | **不必** | 同上 |

> **`benchmark/_probe*.mjs` 必须跟着改。** 它们是"期望值从哪来"的可复现记录：
> 改了工具输出却只改 `tasks/` 里的断言，等于把 benchmark 变成"照抄当前输出"——
> `bench --offline` 照样绿，但它证明的东西就没有了。同理，改了任务断言要顺手
> 用 `node benchmark/_freeze-trace.mjs <report.json>` 把真实响应重新冻结进
> `test/fixtures/benchmark-traces.json`，否则判分器的回归守卫会拦下你。

**两道零成本的门永远要绿**（它们在 `npm test` 里，无论改了什么都会跑）：

```bash
node benchmark/run.mjs --offline    # 每条 where:"tool" 断言是否仍等于工具的真实渲染输出
node test/benchmark-coverage.mjs    # 60/60 工具有任务覆盖、fixture 前提仍成立、tier 与占位符健全
node test/benchmark-score.mjs       # 判分器对冻结的真实响应仍判对，且仍能判错
```

`--offline` 是**便宜的**（几百毫秒、不调模型），所以它进 `npm test`；
`--model` 是**贵的**，所以它按需跑。**两者的分工是刻意的**：
offline 证明"期望值仍然为真"，model 测量"模型是否仍然会用"。前者证明后者有意义。

### 跑哪一档

| 场景 | 命令 | 代价 |
| --- | --- | --- |
| **日常：改完就直接测** | `node benchmark/run.mjs --model --changed` | **只跑受影响的那几题**，或明确告诉你"无事可跑" |
| 改了**一个**工具 | `node benchmark/run.mjs --model --tools <工具名>` | 该工具涉及的题 |
| 改了**几个**工具 | `--tools a,b,c`（也接受 `molbio_` 前缀与 `primer_*` 通配） | 并集 |
| 改了**一个**已知任务 | `--task <id>` | 一题 |
| 改了**共享模块**，想知道影响面 | `--list --changed`（不花钱） | 0 |
| 发版前 | `node --run bench:full` | 61 题 |
| 只是提交文档 | `--changed` 会回答"无事可跑" | 0 |

```bash
# 改完代码的第一选择：让工具自己判断该跑什么
node benchmark/run.mjs --list  --changed        # 先看判断结果，零成本
node benchmark/run.mjs --model --changed        # 再花 tokens 跑那几题

# 我明确知道自己改了 molbio_primer_tm
node benchmark/run.mjs --model --tools primer_tm

# 改断言之后：用记录下来的响应免费复算，不用重跑模型
node benchmark/run.mjs --replay --changed
```

### `--changed` 怎么判断（以及它为什么不会漏）

它**不是**一张手写的映射表，而是从代码里量出来的：

```
改动的文件 → 它属于哪个模块（目录里的 .mjs 集合）
           → 哪些模块（传递地）import 了它
           → 那些模块用到的每一个工具
           → 覆盖这些工具的每一道题
```

两个具体例子（实测输出）：

```
$ touch crispr.mjs && node benchmark/run.mjs --list --changed
1 of 49 task(s) selected — --tools molbio_grna_design --changed
  (from --changed; 2 module(s) affected: crispr.mjs, index.mjs)

$ touch lib.mjs && node benchmark/run.mjs --list --changed
48 of 49 task(s) selected — --changed (27 module(s) affected: align.mjs, cloning.mjs, …)
```

注意 `crispr.mjs` 的影响面里有 `index.mjs`，而 `lib.mjs` 几乎选中全部——**这正是正确答案**：
`lib.mjs` 是几乎每个工具都依赖的共享库，改它本来就该重测全部。

**宁可多跑，绝不漏跑**，四条具体规则：

1. **不可判定 → 全量**：没有 git / 没有 HEAD / 读不到插件结构，一律回落全量并打印原因；
2. **认不出的文件 → 全量**：新模块、重命名的文件（`not in the plugin's module set`）；
3. **`index.mjs` → 全量**：它是绑定全部工具的那个入口；
4. **映射到的工具有题没覆盖 → 全量**（并由 `test/benchmark-coverage.mjs` 断言 60/60 覆盖）。

反过来，**唯一会返回"无事可跑"的情况**是改动**可证明**不影响工具行为：`docs/`、
`CHANGELOG.md`、`README.md`、`test/`、`benchmark/`、`package.json`。这不是走后门——
它和 `--changed` 是同一个开关，不写 `--changed` 时一切都照旧跑。

### `--changed` 与 `--tools` 的两个算子

| 写法 | 含义 |
| --- | --- |
| `--changed` | **并集**？不——它只选"受影响的工具" |
| `--tools X` | 只按名字选 X |
| `--changed --tools X` | **交集**：在我改动的工具里，只跑 X |

交集只能**减少**运行量，永远不会掩盖改动（危险方向是放大），所以它被允许；
两者都打印自己的算子，因为搞混这两个就是"测了改动"和"测得比改动还少"的区别。

### 仍然照跑全量的那一半

`--changed` 只决定**跑哪些题**；只要开始跑，两道离线门仍然跑**全量**（几百毫秒、不调模型）：

```bash
node benchmark/run.mjs --model --changed
# 内部先执行完整 scoreSuiteOffline()：49 条 where:"tool" 断言全部重算
```

这是"只跑一部分"能成立的**前提**——它把"跳过是因为没改"从记忆变成受检的断言。
它的盲区照旧：离线门只看工具**输出**，看不见"模型还选不选得对"。所以：

- 改工具实现/描述 → `--changed`（或 `--tools <它>`）；
- **改共享模块** → `--changed` 会自动放大到全量，这正是它该做的事。

**新增/改动 benchmark 任务的三步**

1. 在 `benchmark/tasks/*.json` 加或改任务（`covers` 必须列出它练的工具）；
2. 在 `benchmark/verifications.mjs` 的 `invocationsFor` 里加产生这些期望值的调用；
   期望值一律用 `node benchmark/_probe.mjs` / `_probe-all.mjs` **实测**，不要凭记忆写；
3. `node benchmark/run.mjs --offline` 必须先绿，再跑 `--model`。
   若一条断言在 `--offline` 失败，是**断言的错**，不是模型的错——先把断言修对。

`node test/benchmark-coverage.mjs` 会拦住"新工具没有任务""任务没有 offline invocation"
"fixture 前提失效"这三类漂移；`test/benchmark-score.mjs` 用**真实响应的冻结副本**
（`test/fixtures/benchmark-traces.json`）拦住"断言退化成给措辞打分"。

---

## 3. 客户端产物（browser half）

浏览器半由 `build/client-bundle.mjs` 从**包根的同一份 `.mjs` 源文件**生成到
`lib/client.js`，并同时为面板专用包产出 `packages/molbio-panel/lib/client.js`。改完源码后：

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

### 安装与修复面板

把面板装进某个 profile 只有一条正路：

```bash
dsh plugin --profile <profile> add <仓库路径>/packages/molbio-panel
```

profile 用的是 pnpm 的 **hoisted** linker，而 `link:` 依赖的软链**只由 `add` 物化**：
如果 `node_modules/<包>` 丢了（被清理、被误删、或 profile 目录被其它操作动过），
`dsh plugin --profile <profile> install` 与 `pnpm install --force` 都只会回答
"Already up to date" 而**不会重建链接**。修复办法就是重新 `add` 一次同一个路径（无需网络，
package.json 与 lockfile 里的声明不变）。装完核对三件事：链接存在、`package.json` 里
`dsh.client.platform === "web"`、`lib/client.js` 存在且与仓库产物同哈希。

### UI 起不来（`Failed to load plugins`）的排查顺序

顶栏这条横幅 + `failed to apply loader entry <id> (<name>): <message>` 说明某个**客户端
entry 的 `apply()` 抛了异常**，加载器拒绝 boot——不是"面板没挂上"。先止血：
`dsh plugin --profile <profile> remove <包>`（或从 profile 的 `dsh.profile.bundles` 里去掉
那一行）后重启。定位：

1. `node test/client.mjs`——抢座位的顺序那一层会当场复现"未声明座位 `register()`"这类错误
   （0.7.1 → 0.7.2 就是这么被测出来的：`slot "tool.call.toolview" is not declared (a parent
   entry's children table must declare it)`）；
2. `node test/contract.mjs`——判断是 DSH 动了契约（slots 服务没了 `inject`、座位不再由同一条
   entry 声明）还是本包写错；
3. 改 `build/client-entry.mjs` → `node build/client-bundle.mjs` → 重启：**产物不重新构建就
   没有任何效果**（浏览器拿的是 `lib/client.js`，按 `rev` 哈希失效）。

---

## 4. 发布流程

### 发布前预检（0.7.1 事故之后加的硬步骤）

**任何**要 push 或打 tag 的版本，先跑完这几步，缺一步都不算发布完成：

```bash
npm test                     # 全部套件 + benchmark 两道离线门 + 发布守卫（test/release.mjs）；
                             # 客户端半、光栅化器或 preset 组合的改动必须全绿
node build/client-bundle.mjs # 产物与源同一批构建（`--check` 只报告陈旧、不落盘）
node build/preset-patch.mjs --check   # 改了 preset 行清单才需要（见下）
node build/release-preflight.mjs --tag v<版本>   # 发布特有的不变量（见本节末尾的 CD 段）
git status --short           # lib/client.js 与 packages/molbio-panel/lib/client.js 不得是未提交状态
```

> **推 tag 之后这些步骤由 CI 再跑一遍**（`.github/workflows/release.yml`），所以本地这一步是
> "别把红的东西推上去"，不是发布本身的凭据。CD 的完整说明见本节最后的
> 「持续交付（CD）：推一个 tag 就发完」。

**改了 preset 的行清单**（`preset/molbio-lab/agent.cordis.yml`，**行清单**）额外一条：
跑 `node build/preset-patch.mjs` 重新生成根目录的 `cordis.patch.yml`（唯一 bundle patch）；
`--check` 会因两者不一致而失败，`npm test` 里没有这一项，别忘。

`preset-health.mjs` 必须报 `OK`。它现在把本包的 preset **行**与**已安装 harness 自带的
`standard`** 逐行对比——0.1.7-alpha.1 起上游基线是
`<harness>/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml`
（旧的 `@deepseek-ai/dsh-agent-presets/presets/standard/agent.cordis.yml` 已随该包一并消失）。
只应剩 `tool-molbio` 这一行差异（0.2.1-rc.2 起上游自己也带 `skill-filesystem` 与 `tool-skill`）。

客户端半的改动还有两条**专门针对"会弄坏 GUI"**的确认：

1. **产物已构建且已提交**——profile 与 `dsh plugin add` 消费的是**产物**：源码改了而产物没
   重建，用户加载的还是旧逻辑；产物没提交，别人装到的就是旧逻辑。
2. **安装态与产物一致**（profile 用 junction 指向工作区时，这一步等于自查）：

   ```powershell
   (Get-FileHash packages\molbio-panel\lib\client.js).Hash -eq `
   (Get-FileHash $env:USERPROFILE\.dsh\profiles\<profile>\node_modules\dsh-molbio-panel\lib\client.js).Hash
   ```

   哈希不一致 = 你验证的和用户加载的不是同一个东西。

### preset 渠道

1. 修改包根代码并跑 `node test/smoke.mjs`（插件）与 `node test/preset-health.mjs`（组合）；
2. 如果改了 preset 的**行清单**，跑 `node build/preset-patch.mjs` 重新生成
   根目录的 `cordis.patch.yml`；**没有版本目录要新建、没有拷贝要同步**——preset
   行按包名引用本包，`dsh plugin update` 直接生效；
3. 更新 `CHANGELOG.md` 并把 `package.json` 的 `version` bump；
4. commit + push，然后打**带日期的注释 tag**（仓库用 `v<包版本>`，如 `v0.13.0`）：

   ```bash
   git tag -a v0.13.0 -m "0.13.0: DSH 0.1.7-alpha.1 adaptation (panel read fix, preset as bundle patch)" && git push origin v0.13.0
   ```

### DSH 升级后：preset 组合的维护（必做）

`preset/molbio-lab/agent.cordis.yml` 是官方 `standard` 预设的**行清单**副本 + 末尾一行
`tool-molbio`（当前基线：**dsh 0.2.1-rc.2**）。它不会自动跟随 DSH 升级，因此每次升级
DSH 后：

1. 取新版的 shipped `standard`：
   `<harness>/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml`；
2. 与 `preset/molbio-lab/agent.cordis.yml` 对比（把上游的 `config.plugins:` 块与我们的行清单
   对齐看），**逐行吸收上游改动**（新增/删除的行、注释、key 顺序、配置契约变化），只保留
   `tool-molbio` 这一处有意差异与头部注释。**照抄上游文本，不要手写"看起来等价"的行**——
   上游在 0.1.6-alpha.1 用 `workflow-worker-thread` 教过一次。上游这份文件**不一定带行内
   注释**（0.2.1-rc.2 就是纯行清单）：照抄即可，别把我们自己的解释混进去；`preset-health`
   只比结构，注释漂移抓不住，但下一次人工 diff 会；
3. 跑 `node build/preset-patch.mjs` 重新生成根目录的 `cordis.patch.yml`；
4. 跑 `node test/preset-health.mjs` 直到 `OK`（它把任何结构差异当**发布阻断**，不只是打印
   note），再跑 `node test/drift-probe.mjs` 确认守卫仍能抓到漂移；
5. 更新 `agent.cordis.yml` 头部"Baseline: …"那行里的 DSH 版本号；
6. 跑 `node test/benchmark-profile.mjs`：benchmark 的 headless profile 是从这份行清单**推导**
   出来的，上游加行、改 config 都会在这里失败（它会把每一行逐字段比对），按提示把新行分类
   （mount 或写进 `SKIPPED_ROWS` 并给理由）后跑 `node benchmark/profile.mjs` 重建；
7. **用户不需要做任何事**：preset 随 bundle 走，`dsh plugin update` 之后重启 profile 即可。
   （0.1.7-alpha.1 之前用"复制到 `~/.dsh/.agent-presets`"的用户，其副本已不再被读取，应删除——
   这正是 0.1.7 升级时最容易留下的一具"看起来装着、其实没生效"的僵尸。）

### npm 发布（v20 实测的两个坑）

root 包与面板包是**两个独立的 npm 条目**，**必须分开发布，且面板包要在它自己的目录里跑**
（在仓库根跑两次 `npm publish` 会**两次都发布 root 包**）：

```powershell
cd <仓库根>            # 发布 dsh-molbio-tools
npm publish --access public
cd packages\molbio-panel   # 发布 dsh-molbio-panel（另一个条目）
npm publish --access public
```

- **`npm pack --dry-run --json` 是发布前唯一能核对"包里到底有什么"的手段**（`files` 白名单是
  allowlist，漏一个模块就是"装完却没有这个功能"）。
- **`npm whoami` / `npm pack` / `npm publish` 都需要写 `%LOCALAPPDATA%\npm-cache`**。若在受限
  沙箱里跑，会得到 `EPERM ... npm-cache\_cacache\tmp\...`（不是权限坏了，是沙箱拦了工作区外的
  写）；`npm login` 还必须是**真 TTY**，所以登录与 OTP 只能由人来做。
- **"要求写入 2FA"的账号即便 `npm profile get` 显示 `two-factor auth: disabled`，发布仍会被拒**：

  ```
  403 ... Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.
  ```

  `disabled` 指的是登录/其它操作的 2FA，写入策略是另一项。两条出路：交互式 `npm publish` 时
  输入 `--otp <6 位码>`，或用一个勾了 **bypass 2FA** 的 granular access token（环境变量
  `NPM_TOKEN`，不要写进仓库或 `.npmrc`）。

### 持续交付（CD）：推一个 tag 就发完

`.github/workflows/release.yml` 把上面那套手工步骤变成一条流水线。触发条件是**推 `v*` tag**，
不是推 main——版本号就是"这是一次发布"的决定，而 tag 恰好是唯一不可能被顺手推出去的东西。

```bash
# 发一次版本的完整动作（维护者侧）
npm test                                   # 本地先绿（CI 还会在 tag 的提交上再跑一遍）
node build/release-preflight.mjs --tag v0.19.0   # 先干跑一遍发布前置检查
git push origin main && git push origin v0.19.0  # 推 tag = 触发发布
```

流水线按顺序做六件事，**任何一步失败都不会发布**：

1. 断言 tag 形状（`v<major>.<minor>.<patch>`）与 npm CLI ≥ 11.5.1（可信发布的版本下限）；
2. 装**钉死版本**的 harness 并导出 `DSH_HARNESS_ROOT`（与 `test.yml` 同一套推导）；
3. **在被打 tag 的那个提交上重跑全套** `npm test`。这不是重复劳动：tag 可以指向任何提交，
   而 `test.yml` 是被**并行**触发的，所以"测试过了"不是这个 job 能假设的前提；
4. 跑 `build/release-preflight.mjs`（见下）；
5. **分两步**发布：根包 → `cd packages/molbio-panel` 再发面板包。两个是**独立的 npm 条目**，
   在仓库根跑两次 `npm publish` 会把根包发两遍；
6. 用 `build/release-notes.mjs` 把 CHANGELOG 里**该版本那一段**抽出来建成 GitHub Release。

#### 凭据：没有 NPM_TOKEN，用的是可信发布

流水线用 npm 的 **Trusted Publishing**：job 出示 GitHub 的 OIDC token（`id-token: write`），
npm 把它换成一张**短期**凭证，且**限于这个仓库 + 这个 workflow 文件**。仓库里不存在任何长期
密钥，所以没有可泄露、可忘记轮换的东西。

**这条路有一个前提：npm 必须先知道这个包。** Trusted Publisher 是**逐包**在 npmjs.com 上配置的，
而一个不存在的包没有可配置的对象。所以两个包的**首次发布必须由人手动做一次**：

#### 首发（bootstrap）的准确顺序

```powershell
# ① 先推 tag 试一次 CD（可选但推荐）：它会在 preflight 就停下并告诉你"这是首发"
git push origin main
git push origin refs/tags/v0.19.0        # 若之前已推过旧 tag，见下面 ⑤ 的强制推送

# ② 手动首发（只需一次；需要 OTP，npm login 必须是真 TTY，只能由人操作）
cd D:\deepseek-harness\dsh-molbio-tools
npm publish --access public                       # dsh-molbio-tools
cd packages\molbio-panel
npm publish --access public                       # dsh-molbio-panel

# ③ 为每个包配置 Trusted Publisher（npmjs.com → 该包的 Settings → Trusted Publisher）
#    Repository:    lovy2004/dsh-molbio-tools
#    Workflow file: release.yml    ← 只写文件名，不带 .github/workflows/ 前缀
#    Environment:   留空

# ④ 之后每次发版只需推 tag，CD 全程自动
git tag -a v0.20.0 -m "..." && git push origin v0.20.0

# ⑤ 只有"首发之前就已经推过 v0.19.0 的失败运行"才需要这一步：
git push origin refs/tags/v0.19.0 --force   # 把 tag 移到修好的提交，重新触发
```

> **⑤ 的强制推送为什么安全**：那次运行**在 preflight 就失败了，没有发布任何东西**，npm 上不存在
> 这两个包（`npm view dsh-molbio-tools` 仍是 404），所以没有任何已发布版本会被覆盖。一旦某个
> 版本真的发出去过，就**不要**再移动 tag——npm 不允许覆盖同版本号，而且删/改 tag 会让已经
> 引用它的东西对不上。正确做法是发一个更高版本。

> **首发用 `--provenance` 会让包永久变为 public 且不可逆**，对本包（MIT、公开工具）是想要的结果，
> 但要知道这一步不可撤销。

三条容易踩的坑，都写进了守卫：

- **设了 `NODE_AUTH_TOKEN` 反而会关掉可信发布**——npm 见到 token 就不再走 OIDC。所以 workflow
  里**故意不设**它，`test/release.mjs` 直接断言文件里没有对它的赋值、也没有任何 `secrets.` 引用。
- **首发跑 CD 会以 `ENEEDAUTH` 失败，而且失败在 `npm publish` 那一步**：
  `npm error need auth This command requires you to be logged in to https://registry.npmjs.org/`。
  这不是配置写错了，而是可信发布的**固有限制**——Trusted Publisher 是**逐包**配置的，包名还不存在时
  npm 没有可认证的对象，于是回退到"需要登录"。**0.19.0 的第一次真实运行就是这样失败的。**
  **当时的 preflight 已经检测出"包不存在"，却只打印一条 note 就放行**——一个检测到条件却不据此
  行动的守卫不是守卫，只是一行日志。现在 `publishPlan()` 会**拒绝**，workflow 的发布步骤也读它的
  结论（`steps.preflight.outputs.publish_tools` / `publish_panel`），所以首发会在**碰注册表之前**
  停下，并把上面①②两步原文写在错误信息里。
- **面板包的版本线是独立的**（v20 计划里是 `0.1.1 → 0.1.2`），**不与根包同步**。但两者共用
  **同一份客户端源码**（`build/`），所以浏览器半一改，`packages/molbio-panel/lib/client.js` 就变了；
  此时若面板版本不动，第二次发布会拿同版本号发不同字节，npm 会拒绝。preflight 因此会把
  **已发布版本的 `lib/client.js` 抓下来**（直接请求注册表 tarball，在进程内解 tar）与工作区里的
  逐字节比对：不一致就**在发布前**报错，并说明要 bump 面板版本。

> **首发之后，同一个 tag 会被重新推一次。** 因为首发是在本地手动做的，而 CD 那次运行必然已经失败
> （它会走到 preflight 就停下）。把 tag 强制推到修好的提交上是**安全**的：那次失败**没有发布任何
> 东西**，npm 版本号没有被消耗，所以没有任何已发布的版本会被覆盖。命令见本节开头的
> 「首发（bootstrap）的准确顺序」。

#### `build/release-preflight.mjs` 到底检查什么

只检查**只有发布时才会问**的问题；产物新鲜度、`files` 白名单、客户端座位这些**已经在
`test/contract.mjs` 里**，这里**不重复**（重复的守卫会漂移）。

| 检查 | 为什么值得挡一次 |
| --- | --- |
| tag 形状与 `v` 前缀 | workflow 按 `v*` 触发；没有 `v` 的 tag 永远发不出去，放行等于给一个发不出的 tag 开绿灯 |
| **tag 与根包版本互校** | 发出去的版本号来自 `package.json` 而不是 tag；两者不一致会用一个"自称是别的版本"的名字发布 |
| 每个包声明的版本形状 | 面板版本是独立输入，`0.1` 这类不是可比较的发布版本 |
| **CHANGELOG 有该版本条目且足够长** | GitHub Release 的正文就是这一段；没有它就没有发布说明 |
| 清单里客户端半的字段（`dsh.client.platform` / `exports["./client"]` / `dsh.bundle.patch`） | 缺了会**装得上但没有面板**——0.15.2 已经踩过一次 |
| 注册表状态（首发 / 已存在同版本 / npm 更新） | 首发要人手动；同版本要区分"没 bump"与"没改"；npm 更新则说明在发一个更旧的版本 |
| **发布决定（`publishPlan`）** | 上面每条状态**都要落到一个动作**上：`publish` / `skip` / `refuse`。首发与"npm 已有更新版本"是 `refuse`——**碰注册表之前就停**。这正是 ENEEDAUTH 那次失败暴露的缺口：检测到了却没有据此行动 |
| 面板产物是否变了而版本没动 | 见上；这是唯一需要网络与 tar 读取的检查 |

网络相关的那两项**不会因为网络抖动而阻断发布**：取不到注册表时状态记为 `unknown`，只打印
note——真正的判据是发布步骤本身，而一次查不到不应该拦住一次发布。

#### 幂等性、重跑与回滚

- **重跑同一次发布是安全的。** 已经发过的版本再跑一遍，`npm publish` 直接报"版本已存在"而失败。
  要重跑流水线（比如为了补一个 GitHub Release），先把已发布的版本号 bump 出一个新版本。
  preflight 会把"同版本且字节一致"的情况标成 note 而不是失败，便于你判断。
- **tag 不能重指向同一版本号再发。** npm 不允许覆盖同版本；这是 npm 的规则，不是本仓库的选择。
- **回滚没有自动路径。** npm 的 `unpublish` 有 72 小时窗口且会破坏已装用户；正确做法是
  **发一个更高版本**修掉问题（`npm deprecate` 可以给坏版本加警告）。GitHub Release 可以直接删或
  改成 prerelease。这一点是刻意的：自动回滚会让人以为发布可以随便试。
- **并发**：`concurrency: release-<ref>` 且 `cancel-in-progress: false`，所以同一个 tag 的两个运行
  会排队而不是互相打断。

#### 干跑（不花版本号）

`workflow_dispatch` 手动触发时**只跑检查、不发布**（`mode` 那一步决定）：

```bash
gh workflow run release.yml -f tag=v0.19.0      # 演练一次，什么都不发
```

本地等价物不需要 GitHub：

```bash
node build/release-preflight.mjs --tag v0.19.0            # 含注册表查询
node build/release-preflight.mjs --tag v0.19.0 --offline  # 只查本地不变量
node build/release-notes.mjs --tag v0.19.0                # 看一眼发布说明长什么样
```

`test/release.mjs` 把这些决定函数**逐个用变异输入驱动**（tag 写错、版本漂移、CHANGELOG 缺段、
面板版本没 bump、tar 读错文件），所以"发布守卫会拦住"是**被证明过**的，而不是被声明的。
其中两条要真实网络的检查（注册表确实按 `probeRegistry` 的假设回答、真实 tarball 确实读得出）
默认关闭，用 `MOLBIO_RELEASE_NETWORK=1` 打开；真实 tarball 也可以直接指给
`MOLBIO_RELEASE_TARBALL=<路径>`。

---

## 5. 新增一个工具要走完什么

1. 实现放进对应领域的模块（`design.mjs` / `cloning.mjs` / …），纯计算 + 无依赖；
2. 在 `index.mjs` 里用 `define({...})` 注册：`parameters` 是 object-rooted 原生 schema、
   `outputSchema` 必须落在 harness 的 enforced subset 内、`render` 产出文本、
   `isConcurrencySafe` 如实声明（写文件的一律 `false` 或按参数判定）；
3. `test/smoke.mjs` 补**已知值**用例（手算或权威口径），不只是"跑通不报错"；
4. 工具数变化时同步四处：`README.md` 的工具表与计数、`preset.yml` 的描述、`index.mjs`
   顶部注释、`agent.cordis.yml` 的 `tool-molbio` 注释；`preset-health` 的
   `toolCountDrift` 会替你看住 `preset.yml` 那处；
5. 如果新工具同时属于浏览器半（`lib.mjs`/`msa.mjs` 这类被客户端产物 import 的模块），
   必须 `npm run build:client` 并提交产物；`contract.mjs` 的"产物新鲜度"检查会失败；
6. 需要时在 `benchmark/tasks/` 下相应领域的文件里加一条任务（见 [benchmark/README.md](../benchmark/README.md)），
   并先跑 `node benchmark/run.mjs --offline` 证明期望值取自真实输出。
