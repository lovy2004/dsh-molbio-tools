# 变更日志（Changelog）

本仓库有两套版本号，请在提 issue 或对照本文档时区分：

- **包版本（`package.json` / npm / git tag）**：遵循 semver，如 `0.5.1`。
- **preset 版本目录（`dsh-molbio-tools-vN`）**：DSH 的 ESM 模块缓存按文件 URL 缓存，
  每次插件代码变更**必须新建目录**（见 [README 的版本目录规则](README.md#插件更新版本目录规则)）。
  它只增不减，且与 semver 不同步。

版本目录当前指向 v17（`preset/molbio-lab/agent.cordis.yml` 的 `tool-molbio` 行）。

## [0.9.1] — 2026-09-17（DSH 0.1.6-alpha.1 漂移修复：**preset 曾无法挂载**；工具仍为 52）

**背景**：本仓库在 DSH `0.1.5-alpha.2` 上发布，随后机器上的 DSH 升到 `0.1.6-alpha.1`。
升级后 `npm test` 挂了 **2 项**，其中一项不是测试问题，而是**用户可见的故障**：
`Molecular Biology Lab` 预设**根本挂不上**。包版本与 preset 版本目录**均不变**（无插件 `.mjs` 改动，
工具仍 52 个）——但修复必须发出，因为现有安装会照抄包内这份组合文件。

### 修复（真实故障；`test/preset-health.mjs` 抓到，但当时只打印"drift note"并退出 0）

- **preset 引用了不存在的 provider 包**：组合里的 `workflow-worker-thread` 行指向
  `@deepseek-ai/dsh-workflow-worker-thread`，而**没有任何已发布的 DSH 安装这个包**
  （本机 `0.1.6-alpha.1` 只有 `@deepseek-ai/dsh-workflow-ptc`）。该行 `unresolvable`，
  预设 mount 失败，选择器里点开就是加载错误。已改为上游 `standard` 的
  `workflow-ptc`（`config: { provider: spawn }`，与本组合原意一致）。
- **静默的行为偏差**：`tool-ralph` 在包内组合里是**启用**的，而上游 `standard` 明确
  `disabled: true`（工具描述把 `ralph` 限制在"人明确要求"的运行，且完成判定是 worker
  自报而非独立评估）。已按上游改回 `disabled: true`。想用的话按上游注释复制一份 preset 并去掉
  `disabled`，不要在这里偷偷打开。
- **组合文件与上游逐行对齐**：吸收 `0.1.6-alpha.1` 的上游文本（`persona` 的 `suffix`/`prefix`
  顺序、`delegation` 注释、fork 注释、`present` 说明），并删掉上游已移除的
  `tool-subagent-report` 段落。现在 `git diff --no-index` 对比安装的 `standard` 只剩**一个 hunk**：
  末尾的 `tool-molbio` 行（加上文首新增的"维护契约"注释）。这本身就是漂移审计手段。

### 加固（这一版真正的"清障"成果）

- **`test/preset-health.mjs` 的漂移检查从"只比 id"升级为"比行"**：逐行比对**行序**、
  `name`、`disabled`、`isolate`、`config`，并把**漂移从 note 提升为 FAILURE**
  （v17 的 `worker-thread` 就是被"note + 退出 0"放过去的）。`tool-molbio` 是唯一允许的额外行，
  允许清单在文件顶部显式声明。
- **`test/drift-probe.mjs`（新增）**：没人见过失败的守卫不算守卫。用**变异组合**驱动
  `compositionDrift`——幻影 provider 行、被丢掉的 `disabled`、改名、改 config、改 isolate、
  丢行、多余行、行序错乱——断言每一种都被抓到，且对**当前这份组合零噪音**。
  `preset-health.mjs` 因此改为 `if (import.meta.main) await main()` 并导出该函数（Node ≥ 22，
  `package.json` 已加 `engines`）。
- **`test/contract.mjs` 的 hook-prop 规则断言不再绑定 minify 形态**：`0.1.6-alpha.1` 把
  `standardHookPropName` 从 `function $c(t){…}` 编成了**类方法** `$c(t){…}`，原来的
  "整个函数体"正则因此失败（面板本身没问题）。现在断言的是**契约**：稳定导出名
  `standardHookPropName: <symbol>` + 该符号仍实现 `use${首字母大写}${其余}` 这条规则
  （允许 `slice`/`substring`、可选括号、箭头/方法/函数三种写法）。
- **产物新鲜度检查不再依赖 `spawnSync`**：受限沙箱拒绝管道 stdio（EPERM），原检查只能
  "无法验证"——恰好是自动化发版处最需要它的时候。打包器的生成逻辑已抽到
  **`build/client-bundle-core.mjs`**（`createGenerator({ entry, baseDir }) → { order, ids, renderBundle }`），
  `build/client-bundle.mjs` 变成薄 CLI（新增 `--check`：只报告陈旧、不落盘），
  `test/contract.mjs` **在进程内**重算期望产物并与已提交文件逐字节比较。
  字节级等价已实测：重构后重跑打包器，`git status lib packages` 为空。

### 分发注意

- **route-B（已注册 preset 根，推荐渠道）用户**：组合文件是每次挂载重新读取的，
  升级包后**重启 profile 即可**，不需要重新 `add`。
- **复制渠道用户**（把 `preset/molbio-lab/` 拷到 `~/.dsh/.agent-presets/`）：请重新复制这份
  `agent.cordis.yml`（`plugins/` 目录若还在 v16/v17 可不动；组合文件的模块缓存规则不适用）。
- 本机 `~/.dsh/.agent-presets/molbio-lab/` 还留着一份 **v16 的老副本**，同样带
  `workflow-worker-thread`；route-B 生效时它不参与，但若曾用复制渠道请按上面重拷。

### 发版记录

- **工具与 preset 目录不动**：无插件 `.mjs` 改动，**没有新建 `v18` 目录**，`tool-molbio`
  行仍指向 `dsh-molbio-tools-v17`；`package.json` 的 `version` **0.9.0 → 0.9.1**（修复版），
  tag `v0.9.1`。
- 发版前按 `docs/maintainer.md` 的三步预检：`npm test`（8 套件全绿）→
  `node build/client-bundle.mjs --check`（两个产物均报 up to date）→ `git status --short` 干净。
- 升级说明一句话：**"修复在 DSH 0.1.6-alpha.1 上 Molecular Biology Lab 预设无法挂载的问题
  （工具数量与用法不变）"**。

### 仅文档：v18 路线图补入 DSH 0.1.6 新能力的可用性勘察

**不改代码、不改 preset 目录、不改包版本**，只更新 `docs/maintainer.md` 的路线图，把
0.1.6-alpha.1 的"面板内终端 / computer use"逐包核对结果写成 v18 的输入（含证据、门槛与
"不要再重复勘察"的否定清单）：

- **面板内终端：已经在用，零改动。** 浏览器终端（`ctx.terminalController` + xterm.js 标签页）随
  `dsh-web-app` 出厂即启用，与本包右栏面板**同座位共存**（靠 tab `id`/`kind`/guide order 区分，
  `id` 重复会抛异常）。它与 agent 侧的 `ctx.terminals` 是**两套互不相通的实现**，且面板
  **不把终端输出送给模型**。
- **v18 候选 1（推荐）**：给绘图工具增加**可选 PNG 输出**，让模型能自己调用 `dsh-tool-fs` 的
  `read_image` 看图谱/凝胶/logo。现状是"只写 SVG、`read_image` 不收 SVG"，所以差这一步；
  不需要视觉模型、不需要 computer use。
- **v18 候选 2**：用 `ctx.documentPreviews.register({ id, extensions, loading: 'bytes-complete' })`
  + `sidebar.right.tab.document` 座位把 `.pdb/.cif/.sdf/.mol` 放进本包自己的标签页。**范围要说清**：
  这是容器（座位/注册表/字节加载），不是现成 3D 查看器。
- **v18 候选 3（需先验证）**：持久 shell 进 preset。要加 `dsh-terminal` + `dsh-terminal-bash` +
  `dsh-tool-pwsh-persistent`；`sandbox`/`subprocess` 已在 `dsh-base`。两个硬约束：**工具名冲突**
  （`pwsh`/`bash` 与一次性工具重名，必须禁用一次性行，并同步 `preset-health` 的允许清单与组合头部）
  与**唯一待验证点**——从 preset 发布 `ctx.terminals` 需要 `isolate: { terminals: true }` 分组，
  shipped preset 有同类先例但没有 terminal 的先例。
- **明确不在本版**：computer use 的 agent 侧能力（无截图/鼠标/键盘工具、无 OCR、无辅助功能树；
  全树 `screenshot` 只出现一次且是否定句）；agent 驱动浏览器终端（无 `dsh-tool-terminal`）。
  同批勘察的 MCP（`dsh-mcp-client` 未被任何 shipped bundle 挂载；stdio server **不受文件沙箱约束**）
  与 hooks（兼容适配器，不是插件扩展点）作为备选记录在案，不进路线图主线。

### 仅文档：新增 `docs/capability-gap-survey.md`（v18 的选型依据）

不改代码、不改 preset 目录、不改工具数量的第二份规划文档：把"52 个已发布工具相对主流生信
生态缺什么"逐项过筛——九个来源家族（商业质粒/克隆套件、实验台网页计算器、Biopython/EMBOSS/
SeqKit、标准序列统计、微生物组、群体遗传、蛋白预测、比对后处理、测序 QC），每条候选都要同时
通过「(a) 对实验台真的有用于 (b) 能用几百行无依赖、无外部数据/二进制/网络/参考库的确定性算法
实现」两道筛。产出：**40 条排序候选**（含 ext?/纯 JS?/规模/价值四列）、**必做 top-5**、
**"想做但不可行"清单（每条点名确切阻断原因：二进制格式 / 参考数据库 / 模型权重 / 网络 /
算力规模）**，以及全部依赖的 URL 出处（并标注了哪些论断因 403/无正文而只算部分核实）。
它的价值不只是候选池：§3 的否定清单可以直接搬进 README 的"不做什么"，让用户不再要求本工具
做 BLAST/BAM/ML 树。

## [0.9.0] — 2026-09-13（v17：TaqMan 探针、多重 PCR、甲基化/双酶切、蛋白结构图；工具 46 → 52）

**路线图 v17 方向的第一批：五个新工具 + 一个新的 preset 版本目录**。全部为 v11–v13 引擎
之上的确定性纯计算，零依赖不变。

### 新增

- **`taqman.mjs` + `molbio_design_taqman`**：TaqMan（水解探针）测定设计。先用标准引物
  引擎设计 qPCR 尺寸的扩增子（**默认 70–200 bp**，可用 `primer_options` 覆盖），再在
  扩增子内的缺口里放探针并施加探针规则：**5' 端不得为 G**（淬灭）、探针 Tm 至少高出较热
  引物 `min_tm_delta`（默认 5 °C）、无单碱基重复/串联重复、自互补有界、且与两条引物都
  不形成稳定二聚体。每条候选给出探针序列/坐标/方向/Tm 边距/引物 3' 端距离与**逐项公开的
  排序罚分**。几何采用「扩增子两个缺口」模型：`orientation: "forward"` 从正向引物 3' 端
  向外读（标准设计），`"reverse"` 从反向引物 3' 端向外读并报反向互补——一个缺口放不下探针
  时自动回退到另一个，并在 `notes` 里说明。`primer_options` 的 snake_case 键经显式映射
  转成引擎的 camelCase（**0.9.0 开发中抓到并修掉的真 bug：不映射时用户传的窗口会被静默
  忽略而落到默认值**）。
- **`multiplex.mjs` + `molbio_multiplex_check`**：多重 PCR 互扰检查。报告（1）面板内**所有**
  引物对的 any/3'-anchored 二聚体 Tm，超过阈值（默认 47 °C）的标为 conflict；（2）每条引物
  3' 尾的**非预期退火**——自身模板上的脱靶位点（允许配置错配）与**其他模板上的完全匹配**
  （多重交叉反应；**模板序列相同的 target 视为同一个模板**，否则每条引物都会"交叉"到自己的
  扩增子）；（3）扩增子大小**是否可在胶上分辨**（<20 bp 判为 indistinguishable、<40 bp 判为
  close），以及可执行的重设计建议。
- **`protein-structure.mjs` + `molbio_helical_wheel` / `molbio_hydropathy_plot`**：
  - 螺旋轮（Schiffer-Edmundson 投影）：残基按 3.6 残基/圈（100°/残基）落在圆周上，按
    疏水/极性/酸性/碱性着色并生成 SVG；同时给出整段与**滑动窗口（默认 11 残基，Eisenberg
    标准）**的最大疏水矩 μH（Eisenberg 共识标度）、疏水残基比例与提示。字形用绝对字号 +
    `textLength` 定位，逐字形断言不超残基圆（沿用餐 0.6.0 序列标识图的教训）。
  - Kyte-Doolittle 疏水性图：滑动窗口（默认 9；跨膜段建议 19–21）、GRAVY、**达到阈值
    （默认 1.6，经典跨膜判据）的峰**及逐残基 profile，写成 SVG 并自动打开。
- **`methylation.mjs` + `molbio_methylation_check` / `molbio_double_digest`** 与
  `lib.mjs` 的两张参考表（`METHYLATION_SENSITIVITY`、`ENZYME_BUFFERS`/`BUFFERS`）：
  - **甲基化检查**：找出序列中每个 Dam（GATC）与 Dcm（CCWGG，双链向）位点，报告哪些酶的
    识别位点与之重叠，并把每个酶分类为 `cuts` / `impaired` / `blocked` / `no_site`——这正是
    "酶没问题、但用 dam⁺/dcm⁺ 宿主提的质粒切不动"的经典场景。默认检查对象是甲基化表覆盖且
    **消化酶表里确实存在**的 21 个酶（表里的 AvaII/MboI/EcoRII/PspGI/TaqI/HphI/BstNI 不在
    消化表中，报 0 位点是误导），也可传 `["common"]` 查全表。
  - **双酶切**：两个酶各自的切点/片段、合并切点与合并片段（线性/环状），以及**两者是否共用
    buffer**（标准 NEB 系列；无共用 buffer 时明确给出"顺序酶切/换用厂商双酶切 buffer"的建议），
    并标出某酶在本模板上无位点、或两酶切在同一磷酸二酯键的情形。
  - **两张表都是手工转录的速查数据**，每个结果都随附 `METHYLATION_DATA_NOTE` /
    `BUFFER_DATA_NOTE`，要求对照厂商当前表格复核后才可作为实验依据。
- **客户端半**：`build/browser-api.mjs` 把 v17 的纯计算面（甲基化/buffer 表、探针与多重
  分析、蛋白图渲染器）一并再导出，**面板本身在 v17 未改动**；产物重建（184.9 KB →
  332.9 KB），`npm run build:client` 与所有客户端测试已同步。

### 修复（实现过程中发现并修掉的真实缺陷）

- **探针几何（三次纠正，最终为"缺口模型"）**：初版把引物名字当成了模板坐标顺序，导致
  探针窗口在多数扩增子上为空；第二版把"正向引物 3' 端 + 上游引物 3' 端"混用，产出**与引物
  重叠的探针**；第三版才落到"扩增子物理缺口 + 从开缺口的引物向外读"这一条规则，并由
  smoke 对**每一条返回的测定**断言：探针等于模板切片（或反向互补）、不与任一引物重叠、
  距离正是从开缺口引物 3' 端量起、5' 端非 G、无 run、Tm/GC 在窗口内。
- **`primer_options` 全表静默失效**：见上（snake_case → camelCase 映射）。
- **几何之外的静默数据问题**：`amplicon.length` 未给坐标时序列化为 `undefined`（非 lossless
  JSON，被 harness 的输出校验拒绝）——改为字段整体缺省；`methylation` 的 `in_methylation_table`
  字段未进 schema——补齐。
- **`test/contract.mjs` 的新鲜度断言在受限沙箱下误导**：`spawnSync` 被沙箱拒绝（EPERM）时
  原来打印"the bundler runs cleanly"，容易误读成打包器崩了；现在把 spawn 失败与打包器失败
  分开报告，并给出人工核对命令。

### preset 与分发

- **新建 `preset/molbio-lab/plugins/dsh-molbio-tools-v17/`**（版本目录规则：插件 `.mjs` 有
  改动，必须新建目录），`agent.cordis.yml` 的 `tool-molbio` 行指向 v17，`preset.yml` 描述
  同步到 52 个工具。
- **`package.json` 版本 0.8.0 → 0.9.0**；`files` 白名单覆盖新增 `.mjs`（`files` 用的是包根
  相对路径，`.mjs` 逐个列出——`taqman.mjs` / `multiplex.mjs` / `protein-structure.mjs` /
  `methylation.mjs` 已加入）。
- **测试脚本跨平台化**：原来的 `"test": "node a && node b && …"` 依赖 npm 的 shell，在
  Windows 的 cmd/PowerShell 下 `npm test` 直接失败（`&&` 不是 node 的语法）。改成
  `test:unit` / `test:client:node` 子脚本 + `node --run` 串联，`npm test` 现在在
  cmd/PowerShell/git-bash 下行为一致；`docs/maintainer.md` 的预检说明同步。

### 测试

`test/smoke.mjs` 新增 v17 段（工具 46 → **52** 个注册，逐工具输出 schema 校验）：

- **TaqMan**：pUC118[1200,1800) 上 7 条测定；对每条断言几何与探针规则的不变式；钉住排第一
  的测定（序列/坐标/Tm 61.71 °C/边距 0.81/Tm 边距距离 6）与一条"缺口在反向引物一侧"的测定
  （距离 67 从反向引物 3' 端量起）；探针 Tm 与 `lib.primerTm` 同源；5 条 Tm 边距不足的
  amplicon 逐条上报；四条选项错误路径（含嵌套 `primer_options`）。
- **多重 PCR**：4 个真实引物对的固定面板——24 条引物对交互、3 条跨 target 二聚体（69.1 /
  66.03 / 61.23 °C）、大小冲突 164 vs 168 bp（indistinguishable）与 103 vs 83 bp（close）；
  相同模板不交叉、不同模板共享 3' 尾（完全匹配仅 8 bp 尾）判为交叉反应；无坐标不产生大小
  冲突；四条错误路径。
- **蛋白图**：14 残基两亲性肽的手算值（μH 0.353、窗口最大 0.584 @3、疏水 10/极性 1/碱性 3、
  首残基 90°/单位圆坐标）；69 残基蛋白的疏水图手算值（GRAVY −0.13、峰 4-10/23-27/52-59、
  首窗口 = 残基 1-5 均值、窗口 21 平滑后 2 峰）；SVG 逐字形/逐顶点断言；四条错误路径。
- **甲基化/双酶切**：手工夹具（3 个 ClaI 位点被 Dam **blocked**、BamHI **impaired**、EcoRI/
  HindIII/XbaI 可用、Dcm 位点不与选择中的酶重叠）；pUC118 全质粒（dam 15 / dcm 5、8 个可用
  酶）；EcoRI+HindIII 环状双酶切（切点 927/876 → 3111+51 bp，CutSmart 等 4 个共用 buffer）；
  无共用 buffer 的 BstXI+SmaI；无位点与共享切点两条建议；错误路径。

## [0.8.0] — 2026-09-12（安装渠道 B：把 preset 注册进 profile，升级不再需要复制）

**新增 `preset/install.mjs`**：把**已安装包内**的 preset 目录注册为 profile 的额外 preset
扫描根，补上"`dsh plugin add` 装了工具、却不出现在预设选择器里"这个缺口。配置改一次，
之后每个版本只跑 `dsh plugin --profile <p> update dsh-molbio-tools`，**不需要再复制、也不
需要再改配置**。

- 机制：在 profile 的 `cordis.patch.yml` 追加一条 `- id: agent-presets` 补丁，其 `config.roots`
  增加 `{ path: <已安装包>/preset, trust: system }`。`config` 是整体替换，因此重述 `default: standard`。
- 为什么值得做：复制渠道把 preset 冻结在复制那一刻，每次发布（版本目录规则要求新建
  `dsh-molbio-tools-vN`）都要重新复制；注册渠道的 root 路径**跨版本恒定**（`link:` 是符号链
  接、npm/tarball 是真实目录，实测从 `link:` 换成 tarball 后路径不变），升级因此只动包、不动配置。
- 脚本性质：零依赖、幂等（已注册即零写入）、写入前备份 `cordis.patch.yml`、写完用
  `dsh --profile <p> --dump-config` 自检；对没有 roster 行的 profile（headless/sdk）**先检查
  bundle 列表再明确拒绝**，而不是写一个必然被 loader 拒绝的补丁。支持 `--dry-run` / `--check`。
- 实测覆盖：组合树解析与 root 出现、幂等、`--check`、`--dry-run` 不落盘、无 roster 行被守卫、
  发现层对已安装副本判定 `healthy` 且四个内置 preset 未受影响、升级（换安装来源）后路径不变；
  补丁形状另用 harness 自己的 YAML 解析器跑 5 种边界（裸 `[]` 占位符、无尾换行、CRLF、已有条目）。
- 两个由实测抓到的坑已写进文档：新 profile 的 patch 文件是**裸 `[]`**，追加会产生第二个顶层
  节点（`end of the stream or a document separator is expected`），必须替换占位符；`roots.path`
  是 `path.resolve` 解析的，**相对路径随进程 CWD 漂移**，必须写绝对路径。
- **工具数量不变（46 个）；preset 版本目录不变**——本次只新增包内 `preset/install.mjs` 与文档，
  未改任何随 preset 分发的 `.mjs`，按版本目录规则无需新建 `v17`。
- 新增 [docs/route-b.md](docs/route-b.md)：用法、机制、升级 Runbook（含"别提前删旧 `vN` 目录"
  等三条纪律）、与复制渠道的取舍表、实测方法与已知限制。

## [0.7.2] — 2026-09-11（修复：座位未声明就注册 → DSH 拒绝启动）

**修复 HARNESS "Failed to load plugins"**（`failed to apply loader entry …(dsh-molbio-panel):
slot "tool.call.toolview" is not declared (a parent entry's children table must declare it)`）。

客户端座位只有在**拥有它的那条 entry 在自己的 `children` 表里声明之后**才存在：`sidebar.right.pane.tab`
由右栏的 `rightbar.session` entry 声明，而 `tool.call.toolview` 是 ui-tool 的
`conversation.chat.node` entry 的**子座位**。0.7.1 的卡片用裸 `ctx.slots.register()` 抢这个座位，
启动图里没有任何东西保证我们的 entry 排在 ui-tool 之后——`register()` 于是抛上述 SlotCore 异常，
异常从本包的 `apply()` 逃出即是**加载器 entry 失败**，也就是整个 Web GUI 拒绝启动（不是"少一个
tab"）。四个右栏座位当时只是碰巧安全（本包 inject 了右栏提供的服务），同样的竞态依然存在。

- 修法：**所有**座位声明改走 `ctx.slots.inject(seat, cb)`（ui-tool / ui-skill / ui-sidebar-right /
  ui-sidebar-documentpreview 都是这个写法）：座位已声明则立即执行，未声明则等声明到达，
  重声明（epoch）时先撤销旧贡献再重放，贡献随本 fiber 销毁。
- 新增 `test/slots-stub.mjs`：按 shell 的 SlotCore 语义复刻"未声明座位 `register()` 必抛
  `… is not declared (a parent entry's children table must declare it)`"与 `inject` 的等待/重放规则。
- `test/client.mjs` 改为从**一个座位都没声明**的最坏启动顺序开始：断言 `apply()` 不抛、四个右栏
  座位在声明后落地、调用卡座位一直等到 ui-tool 声明才落地，并当场复刻那条异常消息本身。
- `test/contract.mjs` 增第 10 项：钉住 shell 仍拒绝未声明座位的注册、slots 服务仍提供
  `inject(key, callback)`、官方包仍用它抢这两个座位，且**本包产物里每一处 `slots.register`
  都必须落在对应座位的 `slots.inject` 里**（数量与配对都断言）。

工具数量不变（46 个）；preset 版本目录不变（本次只动客户端产物与测试，未改随 preset 分发的 `.mjs`）。

## [0.7.1] — 2026-09-10（图谱调用卡：`tool.call.toolview`）

**新增图谱调用卡**：`molbio_plasmid_map` 与 `molbio_plasmid_map_file` 的调用**直接在对话里
画出这次产出的质粒图谱**（摘要行 + 写入路径），不再只给一个文件路径；调用失败时显示错误
文本与 Inspect 入口。

- 宿主侧：两个 map 工具新增 `output.presentationMeta(args, value)` 投影——这是官方文档
  写明的结构化数据通道（`presentResult`/`presentCall` 内置 Web 客户端不消费），且只有
  ROOT 调用会执行。SVG 随 meta 传输设 256 KB 上限：超限时改带 `svg_omitted` 与字节数，
  卡片降级为提示 + 路径（图谱仍写在文件里）。投影是纯计算（图谱标记走一份有界内存缓存，
  不读文件）且不抛——它跑在调用成功之后，抛错会把成功调用标成失败。
- 客户端侧：新增 `tool.call.toolview` 卡片（按工具名取键）。它**校验而非信任** meta：
  缺失/异种/异形/超限/失败一律降级为提示，绝不在对话里抛错；SVG 用 DOM 注入，保持可选中。
- `define()` 包装器转发 `presentationMeta`（此前只转发 schema/render，投影会被静默丢弃——
  由新测试当场抓到）。
- 测试：新增 `test/map-card.mjs`（真实工具 → 投影 → 卡片读取 → 渲染出 SVG，含四条降级
  路径）；`test/contract.mjs` 增第 9 项，钉住"工具层仍调用 `output.presentationMeta` 且只对
  root 调用"与"卡片座位仍按工具名取键"。

工具数量不变（46 个）。

## [0.7.0] — 2026-09-10（浏览器内面板：bundle 渠道 dsh.client 双面包）

**新增两个右栏面板**：**Molbio**（列出会话工作区的序列文件，选中即画图：`.dna`/`.gb`/
`.gbk` → 质粒图谱 + 特征表，`.fa`/`.fasta` → 序列标识图）与 **Papers**（把
`molbio_paper_*` 维护的 `papers.json` 渲染成可搜索的阅读列表 + 详情面板）。解析与渲染在
浏览器里跑的是本仓库自己的模块，与 Node 工具**同一份源码**——不落盘 SVG、不弹系统查看器、
不经过工具调用。

- `build/client-bundle.mjs`：零依赖打包器，产出 DSH 客户端加载器要求的 **lazy-CJS**
  产物（`window.__ModuleLoader__.load({id, factory})`）。官方 `tsdown.client.ts` 预设未随
  npm 发布，故按加载器契约复刻；同时把纯净度门禁前移成构建期检查（禁 `node:` 内建、
  禁裸 specifier、禁动态 `import()`）。**一趟构建产出两个交付包**。
- `build/browser-api.mjs` / `panel-core.mjs` / `client-entry.mjs`：浏览器安全面、面板数据
  通路（无 React、可在 Node 单测）、以及两个右栏 tab 的注册与组件。
- `packages/molbio-panel`：**面板专用包**（宿主半边空实现）——装它只加面板，不会把 46 个
  工具注入该 profile 的每个会话；`dsh-molbio-tools` 则是"工具 + 面板"通道。
- `package.json`：`exports["./client"]` + `dsh.client {platform: web, inject}` +
  两个客户端包的 optional peer；`build`/`lib`/`packages` 进入发布白名单；新增
  `build:client` 脚本。**工具侧无变化（仍 46 个）**，预设渠道与 bundle 渠道可共存。
- 测试（6 个套件）：
  - `test/client.mjs`：按加载器方式执行产物（注册形状、**注册期零全局写入**）+ 两条数据
    通路（真实 pUC118 夹具、文献库投影/搜索/错误路径）；
  - `test/panel-render.mjs`：**真实组件**在最小钩子宿主里跑完整状态机（无 React、无 DOM），
    断言列表/图谱/特征表/logo/搜索/标签/空库/坏库/卸载中止；
  - `test/client-mount.mjs`：复刻宿主侧图扫描，验证两个包能挂上、依赖可解析；
  - `test/contract.mjs`：把面板与宿主的**运行时契约**钉在已安装的 DSH 上（钩子 prop 命名
    规则、root hook 提供方、`workspaceFiles` 的方法与 wire 形状、本包自己的注册与实参顺序、
    以及发布白名单是否真的带上客户端产物）。
- 文档：新增 `docs/client-panel.md`（实现记录：产物格式、三条硬约束、服务契约、上限、
  验证边界与未验证项）。

> 说明：本版本的面板已在本地 web profile 安装并通过全部静态/契约验证，**页面内的实际观感
> 需重启一次 `dsh web` 后在右栏确认**（新插件行在启动时组合）。

## [0.6.0] — 2026-09-10（preset 目录 v16）

**序列标识图与 CRISPR gRNA 设计（路线图 v16 方向）。** 工具总数 44 → 46。

### 新增

- **`logo.mjs` + `molbio_sequence_logo`**：把保守性分析背后的逐列碱基组成画成 SVG
  序列标识图。字母高度 = 信息量 Rᵢ = log₂4 − (Hᵢ + e_n)，纵轴 bits（0-2）；堆叠高度
  按频率分配，经典配色。频率只按残基统计（缺口排除并逐列上报），简并碱基按碱基集合
  摊分权重。`small_sample`（默认开）扣小样本熵校正 e_n = (K−1)/(2·ln2·n)；
  `score_type: "frequency"` 切成纯频率图。输入 `alignment` / `sequences` /
  `fasta_path`，写 SVG 后自动打开。
- **`crispr.mjs` + `molbio_grna_design`**：SpCas9 约定的 PAM 锚定 gRNA 设计。双链扫描
  20 nt protospacer，逐条报告 1-based 顶链坐标、链向、GC%、NN Tm、Primer3 式
  self-any/self-end、种子自互补、发夹 Tm、poly-T，以及逐项公开的启发式评分
  （GC/Tm/poly-T/同聚/自互补/种子/发夹/**每个脱靶 8 分**/PAM 前一位 G +4）。
  硬过滤（GC 上下限、poly-T、3' 自互补、G/C 同聚）可调且报告被过滤条数；
  `check_off_target`（默认开）复用 v12 mispriming 的 k-mer 索引思路做**错配容差脱靶
  搜索**（仅替换、PAM 必须完好、种子末端 2 位不错配），默认只搜得分最高的 200 条候选。
  可选 `save_path`（订购 CSV）与 `map_path`（带 gRNA 标记的质粒图谱）。

### 修复（实现过程中发现并修掉的真实缺陷）

- **反向链 protospacer 长度错误**：初版把 `PAM + guideLength` 整段反向互补，产出的是
  23 nt 而不是 20 nt 的"guide"。已改为 PAM 下游的 20 nt，并在 smoke 里加了
  `sequence.length === 20` 与「顶链切片反向互补 = guide」两条不变式。
- **logo 字形溢出列宽**：初版用 `font-size = 高度/0.72`，2 bits 的列会算出 200+ px 的
  字号、横向压到邻列。改为「字号同时受列宽与图高约束 + `textLength` 压缩宽字形」，
  smoke 里逐字形断言 `font-size`/`textLength` 不超列宽。
- **脱靶计数把自己的靶点算成脱靶**：同一位置可能有多条变体拼写命中（guide 是其自身
  反向互补时更多），已改为按「位置 + 链向」在截断前排除并计数。

### 其它

- `logo.mjs` / `crispr.mjs` 进入 `files` 白名单；preset 组合的 `tool-molbio` 行与
  `preset.yml` 描述同步到 v16 / 46 个工具。

## [0.5.1] — 2026-09-10

**发布修复：preset 在 DSH 0.1.5-alpha.2 上无法挂载；新增 preset 健康检查。**

插件代码（`.mjs`）与 v0.5.0 完全一致，仍为 v15 版本目录——本次只改 preset 组合与文档，
因此**不需要新版本目录**（`plugins/dsh-molbio-tools-v15/` 逐字节未变）。

### 修复

- **`persona` 行在 DSH 0.1.5-alpha.2 上硬挂载失败**：组合里写的是
  `config: { text: ... }`，而当前 `@deepseek-ai/dsh-persona` 的 `Config` 要求
  `prefix`（`suffix` 可选）——校验报 `$.prefix missing required value`，整个
  Molecular Biology Lab 预设无法挂载，会话无法选择该模式。已按官方 `standard`
  预设改回 `prefix` + `suffix` 两段。
- **补回 `present` 行**：`@deepseek-ai/dsh-tool-present` 是官方非 `minimal` 预设都带的
  工具（显式声明工作区交付物）。此前与 `standard` 同步时漏掉了该行，导致 molbio 会话
  缺少 `present`——而本插件的主要产物（图谱/凝胶/曲线 SVG）正是要靠它声明交付。
  它只消费宿主侧 `fs`/`session`/`tools`，不发布服务，无需 realm。

### 新增

- **`test/preset-health.mjs`**：把 preset 组合里的**每一行** config 交给该包自己的
  `Config` schema 校验（与 Loader 挂载时同一套判定，但不启动 harness），并检查
  「行指向的模块是否存在」与「相对官方 `standard` 预设的行差异」。上面那个
  persona 故障正是它能捕获、而 `test/smoke.mjs` 结构上不可能捕获的一类问题——冒烟测试
  证明插件可用，证明不了组合可挂载。
  用法：`node test/preset-health.mjs [composition.yml] [--dsh <harness 根目录>]`。
- `package.json` 增加 `test` / `test:smoke` / `test:preset` 脚本；`files` 白名单纳入
  `preset/`、`test/`、`docs/`，npm 渠道也能拿到可直接复制的 preset 目录。

### 文档

- README：修正「全部 39 个工具」的过时表述（v10 时代遗留，现为 44），补充 preset 安装
  说明与健康检查入口。
- `docs/maintainer.md`：发布流程加入 preset 健康检查步骤；重新核对 DSH 0.1.5-alpha.2。

## [0.5.0] — 2026-08-22（preset 目录 v15）

**多序列比对与保守性分析。**

- 新增 `msa.mjs`：渐进式多序列比对——两两/谱-谱全局比对用**仿射缺口罚分**
  （match +4 / mismatch −4 / 缺口开 −6 / 延伸 −2）且**末端缺口免费**（半全局），
  合并顺序由 **5-mer 距离 + UPGMA** 引导树决定，谱-谱打分用和-对（sum-of-pairs）；
  合并时新缺口按"一旦有缺口、永远有缺口"整列延伸。输入 2-50 条、单条 ≤ 3000 bp、
  总长 ≤ 30000 bp；输出顺序与输入一致。
- 新增 `molbio_msa_align`：返回比对后序列与两两同一性统计，可 `save_path` 写出比对 FASTA。
- 新增 `molbio_conservation`：共识序列（最高频碱基 ≥50%，否则给出 IUPAC 简并码）、
  逐列 identity、熵基保守性（1 − H/2）、保守/可变列统计（`threshold` 默认 0.8）；
  输入可以是已比对序列（`alignment`）、原始序列或 FASTA，后两者自动先比对。
- 工具总数 42 → 44。

## [0.4.0] — 2026-08-20（preset 目录 v14）

**正确性修复 + 图片自动查看。**

- 修正线粒体密码子表中 `AGA`/`AGG` 的终止语义。
- Sanger 验证：氨基酸后果改为**密码子局部**判定，支持框内缺失。
- IIS 酶**反向位点**的顶链切点位置修正（Golden Gate 的 zPrime 连接因此正确）。
- 新增 `view.mjs`：所有生成图片的工具（质粒图谱、克隆/Golden Gate 的 `map_path`、
  标准曲线 `plot_path`、通用绘图、虚拟凝胶）写完 SVG 后用**操作系统默认应用自动打开**
  （Windows `Invoke-Item`、macOS `open`、桌面 Linux `xdg-open`/`$BROWSER`、WSL 转译路径）；
  逐调用 `auto_view: false` 可关，headless 与 `MOLBIO_AUTO_VIEW=0` 自动跳过，
  结果里 `auto_viewed` 回显交接结果。

## [0.3.0] — 2026-08-19（preset 目录 v13）

**反应条件、Golden Gate、酶目录、虚拟凝胶。**

- 两个引物设计工具新增盐/浓度旋钮 `na_mm`/`mg_mm`/`dntp_mm`/`primer_nm`
  （默认 50/1.5/0.8/200），驱动 Tm 的 von Ahsen 2001 盐校正与发夹/二聚体折叠浓度，
  输出 `conditions` 回显实际条件。
- 两个引物设计工具新增 3' 目标位置偏好 `target_position` + `target_penalty`
  （SNP 分型/定点设计），报告 `target_distance`。
- 新增 `molbio_enzyme_lookup`：90+ 酶目录查询；给定序列时报告**双链向**切点
  （IIS 酶的反向识别位点，`molbio_restriction_sites` 不报告）。
- 新增 `molbio_golden_gate`：IIS 酶多片段组装——自动设计唯一/非回文/非互补的 4 bp
  突出端，检查酶不切片段，生成可下单的 `fragments_to_order`，拼出最终质粒并平移特征；
  载体盒子位点保留在骨架（标准 destination 行为，下一级换酶）。
- 新增 `molbio_virtual_gel`：log₁₀ 迁移率模型的虚拟琼脂糖凝胶图 + 分子量 ladder。
- 新增 `molbio_enzyme_lookup` / `molbio_golden_gate` / `molbio_virtual_gel`，
  工具总数 39 → 42。

## [0.2.0] — 2026-08-18（preset 目录 v12）

**引物设计的 Primer3 对齐与错配容差。**

- 结构筛查改为 Primer3 同款热力学模型：自互补（self-any/self-end）比对分
  （match +1 / mismatch −1 / gap −0.25，阈值 8.0/3.0）、发夹与引物二聚体用同一套
  SantaLucia NN 参数折成 Tm（默认阈值 47 °C）、3' 端稳定性（末 5 碱基 ΔG(37 °C)）
  与末 5 碱基 GC 数、GC clamp 0-3 连续分级。
- 引物设计支持**错配容差**：`max_mismatches > 0` 时可用最少的替换挽救无解窗口
  （3' 末端碱基永不错配，默认保护 3' 端 5 bp 关键区），每处错配逐条报告并计入排序罚分；
  精确引物永远优先。跨内含子设计在 spliced/genomic 双坐标下报告错配。
- 新增非特异结合检查 `check_mispriming`：3' 尾在模板双链上的额外退火位点。

## [0.1.0] — 2026-08-16（preset 目录 v10/v11）

**首个公开发布：39 个 molbio 工具 + Molecular Biology Lab 预设渠道。**

- 序列分析、引物设计与检查（含跨内含子 qPCR）、酶切模拟、SnapGene `.dna` /
  GenBank 解析与 SVG 质粒图谱、克隆模拟（酶切-连接 / Gibson）、Sanger 验证、
  蛋白工具、qPCR 与绘图、文献库与协议/实验记录。
- 新增 **Molecular Biology Lab 专属模式 preset**：工具只在选择该模式的会话中出现，
  不污染其它场景；同时保留官方 bundle（`dsh plugin add`）渠道。
- 确立**版本目录规则**（每次更新新建 `dsh-molbio-tools-vN/`），因为 DSH 的 standing
  挂载按 ESM 文件 URL 缓存模块，原地改文件不会生效。
