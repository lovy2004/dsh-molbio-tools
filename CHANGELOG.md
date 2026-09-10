# 变更日志（Changelog）

本仓库有两套版本号，请在提 issue 或对照本文档时区分：

- **包版本（`package.json` / npm / git tag）**：遵循 semver，如 `0.5.1`。
- **preset 版本目录（`dsh-molbio-tools-vN`）**：DSH 的 ESM 模块缓存按文件 URL 缓存，
  每次插件代码变更**必须新建目录**（见 [README 的版本目录规则](README.md#插件更新版本目录规则)）。
  它只增不减，且与 semver 不同步。

版本目录当前指向 v16（`preset/molbio-lab/agent.cordis.yml` 的 `tool-molbio` 行）。

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
