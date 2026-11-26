# 0.28.0 施工计划（候选，待批准）

> 状态：**已实施（0.28.0，2026-11-26）**。批准的范围是 A + B + C 三条线一起做；实际交付
> 7 个工具（72 工具 / 73 题），设计与偏差见第 9 节。上一版为 0.27.1（0.2.3-alpha.2 适配 + 面板修复）。

## 0. 一句话结论

**这一轮没有上游要跟。** 2026-11-26 实查 npm：`latest` = `next` = `0.2.2-rc.5`，
`alpha` = `0.2.3-alpha.2`，与本机桌面版 `app.asar` 内的运行时完全一致；两份清单也都已声明
`0.2.3-alpha.2: compatible`。所以 0.28.0 应当是**工具行为版**，而不是又一个适配版。

**计划阶段的建议范围**是**蛋白质注释套件**——survey #13 + #21，可选 #14，工具 65 → 67（含 #14 为 68）。
**批准时扩展为 A + B + C 三条线一起做**：再加 #10（格式/序列编辑）与 #27 + #31（测序判读），
实际交付 **7 个工具（65 → 72）**、benchmark **66 → 73**；逐项结果与偏差见第 9 节。

## 1. 体检：基线证据

### 1.1 仓库

- `76b960a` v0.27.1，工作树干净，`main` 与 `origin/main` 同步，tag 最新为 `v0.27.1`。
- 65 个 `molbio_*` 工具 / 66 条 benchmark（core 档 14 题）/ 65/65 覆盖 / preset 31 行（均为**实施前**的基线）/
  两份 `lib/client.js` 各 499.8 KB / `package.json` 零 `dependencies`（两条可选 peerDeps）。
- 最近四个版本的节奏：0.24 数据卫生（工具）、0.25 3D 面板（客户端）、0.26 PubMed 徽标（UX）、
  0.27 双链热力学（工具）——按这个交替节奏，下一版轮到的正是工具。

### 1.2 宿主与上游

- 桌面版 `D:\dsh-desk\resources\app.asar` 内的 `dsh-desktop-runtime` 为 **0.2.3-alpha.2**
  （Node 24.22.3，与本包 `engines.node` 一致）。
- npm registry 实查：`latest` / `next` 仍是 `0.2.2-rc.5`，`alpha` 为 `0.2.3-alpha.2`。
  **没有新版本可跟**；`dshReleases` 无需改动。

### 1.3 守卫实跑（把桌面版 asar 当宿主）

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
$env:DSH_HARNESS_ROOT='D:/dsh-desk/resources/app.asar/dsh'
& 'D:/dsh-desk/DeepSeek Harness.exe' test/<guard>.mjs
```

| 套件 | 结果 |
| --- | --- |
| `smoke` | 65 工具全部注册并通过输出 schema 校验 |
| `svgpng` / `svgio` / `charts` / `structure` | 23 / 16 / 26 / 通过 |
| `client` / `panel-render` / `map-card` / `client-mount` | 全绿（client-mount：213 行、82 个 client 行） |
| `contract` | 17 项全绿 |
| `drift-probe` | 17 个突变全部抓到 |
| `preset-health` | 31 行全绿 + specifier + order |
| `benchmark-profile` / `-score` / `-coverage` | 14 行 65 工具 / 49 条冻结响应 / 65-65 覆盖、66 题 |
| `bench --offline` | 66 题期望值全部成立 |

**唯一的红：`test/release.mjs` 第 11 项**，`detectNpmVersion()` 返回 `EPERM`。
根因在沙箱、不在仓库：Node 通过**管道**捕获子进程输出会被 DSH 沙箱拒绝
（`execFileSync(npm.cmd, ['--version'], { stdio: 'pipe' })`），`npm view` 也会在沙箱外的
npm 缓存目录上 EPERM。**发布守卫必须在沙箱外终端跑**；发布前记录这一条，不要把它当成回归。
同理 `benchmark-changed` 在沙箱内读不到 git（`--changed` 自动回落全量，只影响耗时）。

### 1.4 两个环境陷阱

1. 本机全局 npm 的 `@deepseek-ai/dsh` 是 **0.2.2-rc.3**（比桌面版旧）。裸 `node test/...`
   会自动找到它，于是 `preset-health` / `contract` 拿旧宿主比对——必须用上面的 Electron
   形态，或显式 `--dsh "<install>/resources/app.asar/dsh"`。
2. 沙箱内不要尝试 `npm view` / `npm pack` / `git diff` 的管道捕获；联网核对用 `web_fetch`，
   发布动作在沙箱外做。

### 1.5 现存欠账（本轮刻意不碰）

- `png_path` 仍等上游的二进制写入缝（`contract` 里有触发断言）。
- `plot.mjs` 与 `svgio.mjs` 的重复绘图助手（等下次必须动 `plot.mjs` 时一起统一）。
- benchmark 多数工具只有一题，覆盖偏浅；单模型单次运行。
- preset 31 行仍是上游 `standard` 的手工副本（由 `preset-health` 看守）。

## 2. 候选评估（survey 剩余未做项）

| 候选 | 用户问题 | 规模 | 新工具 | 主要风险 | 结论 |
| --- | --- | --- | --- | --- | --- |
| **#13 蛋白特征套件**（PTM 位点 / 低复杂度 / 不稳定指数 / 芳香性 / 柔性） | 这条蛋白哪里糖基化、磷酸化？哪段是低复杂度尾巴？稳不稳定？ | M | 1 | 大表转录出错会**静默算错**；必须用独立已知值验证 | **推荐** |
| **#21 信号肽 + 跨膜段** | 有没有可切除的信号肽？几段跨膜？在哪里切？ | S–M | 1 | 与 `molbio_hydropathy_plot` 的重叠必须划清，否则两个工具给两套数 | **推荐** |
| **#14 抗原性 / 表位启发式** | 哪几段是表面暴露的候选表位？ | S | 1 | 启发式容易被读成预测器；文案必须写明 | 可选加项 |
| #10 GFF3/BED/EMBL + 特征导出 | 把这些质粒的特征导成 BED/GFF3，或把注释挪到另一个文件 | M | 1–2 | 0/1-based 坐标体系是新的静默错面；用户群偏基因组 | 备选（排名最高未做） |
| #27 Sanger 读段组装 | 这几条测序读段能拼成一个完整 contig 吗？ | M | 1 | overlap 阈值、嵌合读段、反向读段 | 备选 |
| #31 编辑结果归类 | 这批 CRISPR 测序读段里到底有哪些等位基因，各占多少？ | M | 1 | 用户会拿它当 TIDE 的编辑效率；边界必须写明 | 备选 |
| #17 串联/反向重复 | 有没有微卫星或重复序列会破坏 PCR/组装？ | S–M | 1 | 与现有 `molbio_dotplot` 概念重叠 | 备选 |
| #24 RNA 二级结构（Nussinov） | 这段短 RNA 会怎么折叠？ | M–L | 1 | O(n³) 输入上限 + “不是 ViennaRNA”的沟通成本 | 不做 |

## 3. 推荐范围与理由

65 个工具里蛋白侧只有 6 个（`protein_props` / `protein_charge` / `peptide_digest` /
`codon_optimize` / `helical_wheel` / `hydropathy_plot`），而“有没有信号肽、跨膜段、糖基化位点”
是表达构建与抗体制备每天都要回答的问题；三个候选全部是**查表 + 滑窗**，不引入外部数据、
二进制或网络，和本仓库“零依赖、纯计算”的约束完全一致。

关键的一点：现成的 `molbio_hydropathy_plot` 只把连续超阈值窗口报成 `peak`，并提示
“candidate transmembrane or signal segment”——**没有切割位点、没有跨膜段清单、没有信号肽判定**。
#21 补的是这三件缺失的事，而不是重画一张疏水性曲线。

## 4. 设计

### 4.1 新模块 `protein-annotate.mjs`（只进宿主半，不进浏览器产物）

沿用 `protein-structure.mjs` 的形态：纯函数 + 导出的参数表 + 明确的出处注释；序列入口统一走
`protein.mjs` 的 `normalizeProtein()`（严格 20 种氨基酸），错误统一 `MolbioInputError`。

各表来源与**验证要求**（这是本轮最主要的风险控制，见第 7 节）：

| 表 | 来源 | 验证方式 |
| --- | --- | --- |
| PTM 基序 | ELM/Expasy 文档化的正则（N-{P}-[S/T]、W-x-x-W、G-{EDRKHPFYW}-x-x-[STAGCN]-{P}、ψKxE、R-R-x-[S/T]、[S/T]-x-x-[D/E]、[S/T]-P） | 手工构造的正/负例逐条断言，**每个基序至少一正一负** |
| Kolaskar–Tongaonkar A(p) | EMBO J 1990 的 20 值表（EMBOSS `antigenic` 文档） | 用一个短肽手算 7-mer 均值，且与 EMBOSS 文档示例一致 |
| von Heijne 信号肽矩阵 | `sigcleave` 的 −13..+2 权重表（真核 / 革兰阴性两套） | 已知的信号肽阳性序列（如 OmpA、人胰岛素原）与阴性序列对拍 |
| Guruprasad DIWV（20×20） | 1990 不稳定指数原表 | **门控项**：只有能对上文献/ProtParam 公布的 II 值才发货；对不上就把 `instability_index` 从本版移除，只保留芳香性 |

低复杂度用 **SEG 风格的熵窗口**（默认窗口 12、复杂度阈值 2.2、去两端低熵）——文案必须写
“SEG-style approximation, not SEG”，不做低复杂度数据库比对。

### 4.2 工具 `molbio_protein_features`

- 入参：`sequence`（必填）、`window`（默认 12）、`entropy_threshold`（默认 2.2）、
  `max_sites`（默认 200，超出置 `truncated: true`，复用本仓库既有的截断惯例）。
- 输出：`length`、`ptm_sites[]`（`type` / `position` / `motif` / `context`）、
  `low_complexity_regions[]`（`start` / `end` / `length` / `entropy`）、
  `composition`（`aromaticity`、可选 `instability_index` + `stable` 判定）、`notes[]`。
- 文本渲染：一行摘要 + 每类位点若干行；**不画 SVG**（S 级工具，保持轻）。
- 并发安全：`isConcurrencySafe: true`（纯计算、不写文件）。

### 4.3 工具 `molbio_signal_peptide`

- 入参：`sequence`、`organism`（`eukaryote` | `gram_negative`，决定用哪套权重表）、
  `threshold`（默认 3.5，权重单位）、`tm_window`（默认 19）、`tm_threshold`（默认 1.6）。
- 信号肽：在 −13..+2 窗口上逐位打分，取最高分位置；`score > threshold` 才报 `cleavable: true`，
  同时报 `cleavage_after`（−1/+1 之间的残基号）与前后 3 个残基的上下文。
- 跨膜段：**直接复用** `protein-structure.mjs` 的 Kyte–Doolittle 窗口（同一套窗口/阈值），
  把连续超阈值窗口合并成 `transmembrane_segments[]`（`start` / `end` / `length` / `mean_hydropathy`）。
- 输出里显式写“与 `molbio_hydropathy_plot` 的 peak 是同一套窗口参数”，避免两个工具各报一套数。
- 文本渲染 + 一张分数曲线 SVG（复用 `svgio.mjs`；**不引入 `<g>`/`<linearGradient>`**）。

### 4.4 可选工具 `molbio_antigenicity`（#14，S 级）

Kolaskar–Tongaonkar 7-mer 平均 propensity + Parker 亲水性 + Emini 可及性 + Karplus–Schulz
柔性四列，合成一个“表面暴露候选”区间表；输出区间与逐位曲线，明确写“启发式排序，不是表位预测”。
若 0.28.0 的时间只够两件，这一项整体推到 0.28.1。

### 4.5 明确的非目标

- 不做 TMHMM / SignalP / NetNGlyc / BepiPred 这类**训练权重**模型——只在描述与 README 里
  写成“启发式”，并点名它们与模型预测的区别。
- 不预测跨膜**朝向**（N-in/C-out 之类）；只报候选跨膜段与信号肽切割位点。
- 不报糖基化**占有率**；只报基序命中。
- 不改动任何既有工具的输出（`molbio_hydropathy_plot` 的数字一个都不动）。

## 5. 施工顺序（批准后）

1. `protein-annotate.mjs`：参数表 + 四个纯函数 + 导出常量；先写**已知值**单元断言，再注册工具。
2. `index.mjs`：注册 2（或 3）个工具，补 system prompt 的蛋白段落，`files` 白名单加新模块。
3. `test/smoke.mjs`：正/负例、边界（短肽、无位点、超 `max_sites`、非法字符、阈值放宽才能救回）。
4. benchmark：`protein-features`、`signal-peptide`（可选 `antigenicity`）三条 full 档任务 +
   `verifications.mjs` invocation；先用 `_probe*.mjs` 记录真实输出，再 `--offline` 转绿。
5. 计数同步：`preset/molbio-lab/preset.yml` 描述（`toolCountDrift` 会 FAIL，**必改**）、
   `agent.cordis.yml` 两处注释、`build/preset-patch.mjs` 重新生成 `cordis.patch.yml`、
   README 十处 65、`docs/maintainer.md` 的 65 与模块表、`index.mjs` 顶部说明。
6. `npm test` 全绿 + `bench --offline` + `test/benchmark-coverage`（67/67）。
7. 定向真实模型跑：`node benchmark/run.mjs --model --tools protein_features,signal_peptide`。
8. 版本：根包 `0.28.0`；面板包只在 `lib/client.js` 字节变化时才 bump（本模块是宿主半，
   预期 **不 bump**，与 0.27.0 因 `lib.mjs` 进浏览器半而 bump 的情形不同）。
9. CHANGELOG 0.28.0、`docs/history.md`、`docs/roadmap.md`（状态改 0.28.0、#13/#21 标 ✅）、
   commit + tag。

## 6. 验证清单

- [ ] `smoke`：工具数 67，输出 schema 逐个通过；每个 PTM 基序至少一正一负。
- [ ] 信号肽：已知阳性（OmpA / 胰岛素原）与阴性（胞质蛋白）各一条；阈值边界两侧各一条。
- [ ] `instability_index`：**能对上文献值才发**；否则本版移除并在 CHANGELOG 写明原因。
- [ ] `benchmark-coverage`：67/67 覆盖、68 题（含 #14 则 69）。
- [ ] `preset-health`：31 行、工具数描述与真实注册数一致。
- [ ] `bench --offline`：所有 `where: "tool"` 期望值成立。
- [ ] 新 SVG 通过 `svgpng` 的 `unsupported` / `missing_glyphs` 为空断言。
- [ ] 沙箱外跑 `test/release.mjs` 与 `build/release-preflight.mjs`。

## 7. 风险与缓解

1. **大表转录错误（最高风险）**。400 个 DIWV 值或 320 个信号肽权重抄错一个，结果会“看起来
   合理但差一点”，正是本仓库最忌讳的静默错。缓解：每个表都用**独立来源的已知输出**验证，
   验证不过就砍功能，不发货；表旁注明出处与推导脚本，和 `build/rebase-audit.mjs` 的做法一致。
2. **启发式被当成预测器**。缓解：工具描述、渲染文本、README 方法学、CHANGELOG 四处都写
   “heuristic, not a trained model”，并点名对照的模型（SignalP/TMHMM/NetNGlyc）。
3. **与 hydropathy 工具的数字打架**。缓解：#21 复用同一函数与默认参数，并在输出里点名
   同源；`smoke` 断言同一序列两个工具的跨膜段/峰一致。
4. **输出膨胀**。缓解：`max_sites` + `truncated`，长序列只给区间不给逐位明细。
5. **benchmark 成本**。缓解：三条任务都是 full 档，发版前用 `--tools` 定向跑，不默认全量。

## 8. 备选方案（若批准另一条）

- **保守（忠于 survey 排名）**：0.28.0 = #10 的一个切片——`molbio_feature_export`
  （特征 → GFF3/BED/CSV，含坐标体系转换）+ `molbio_sequence_edit`（rotate/insert/split/join）。
  规模 M；把 0/1-based 的差一错做成可执行断言，正好符合本仓库的偏好。
- **湿实验闭环**：0.28.0 = #27 Sanger contig 组装 + #31 编辑结果归类。故事完整
  （设计 → 克隆 → 测序 → 判读），复用 `sanger.mjs` / `align.mjs`；#31 必须明确“不是 TIDE”。
- **最小版**：0.28.0 只做 #21 一个工具（65 → 66），风险最低，但一版只加一个工具偏薄。

无论选哪条：本版**不混客户端/面板改动**（保持 `lib/client.js` 字节不变），也**不改既有工具输出**，
这样回归面只有新工具 + 计数同步。

## 9. 实施结果与偏差（0.28.0）

计划批准为“A、B、C 一起做”，已按第 4 节的设计落地 7 个工具：

| 工具 | 候选 | 实现要点 |
| --- | --- | --- |
| `molbio_protein_features` | #13 | PTM 基序、SEG 风格熵窗口、芳香性、Guruprasad 不稳定指数（DIWV 转录自 Biopython 1.88） |
| `molbio_signal_peptide` | #21 | von Heijne 1986 权重（EMBOSS 两套表）、跨膜段复用 hydropathy、分数 SVG |
| `molbio_antigenicity` | #14 | Kolaskar–Tongaonkar A(p) + Parker/Emini/Vihinen 区间均值 |
| `molbio_feature_export` | #10 | GFF3/BED/CSV，逐格式坐标转换，CDS phase 写 `.` |
| `molbio_sequence_edit` | #10 | rotate/insert/delete/replace/split/join（精确 overlap 校验） |
| `molbio_sanger_assemble` | #27 | 贪心 OLC、双朝向、质量加权共识、可选环化 |
| `molbio_editing_outcome` | #31 | 精确变异签名聚类、CDS 效应、净长度移码判定 |

与第 4 节相比的四处偏差（都是实现中证明更正确的选择）：

1. **信号肽加 `max_cleavage`（默认 50）**。原设计按 EMBOSS sigcleave 扫全序列；阴性对照
   （GFP 片段）在残基 70 处得到 4.787 分被误判，因此把 N 端范围做成参数并默认 50。
2. **#14 用 Vihinen 柔性，不含 Karplus–Schulz**。换成一个有权威来源、可与 Biopython 对拍的表，
   比多一列“来源不够硬”的数更有价值。
3. **编辑结果增加跨度下界**。只有 identity 时，一段 60 nt 的纯 C 读段能被短局部匹配收成 wild type；
   现在要求至少比对到读长一半（最少 20 bp）。
4. **移码按净长度变化判定**。3 bp 缺失会被局部比对拆成两段，逐段 `%3` 会误报 frameshift。

面板包保持 `0.1.17`：三个新模块只在宿主半，`lib/client.js` 字节未变。
