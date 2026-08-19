# dsh-molbio-tools

面向 DeepSeek Harness 的**零依赖分子生物学研究插件**：序列分析、引物自动设计与检查、限制性酶切模拟、GenBank 解析与质粒图谱、qPCR 分析、文献助手与实验台计算。除文献检索与存储外全部为确定性纯计算；插件由纯 `.mjs` 文件构成，可随 agent preset 目录整体复制分发。

## 提供的工具（39 个，模型可调用）

### 序列分析

| 工具 | 功能 |
| --- | --- |
| `molbio_reverse_complement` | 反向互补 / 互补链（IUPAC 简并码，自动忽略空白与数字） |
| `molbio_gc_content` | 整体 GC 含量 + 可选分窗口 GC 百分比 |
| `molbio_translate` | 1/2/3/-1/-2/-3 或六框翻译（3 套密码子表），ORF 查找 |
| `molbio_restriction_sites` | 内置 **90+ 限制酶**（v10 起含 IIS 型：BsaI/BsmBI/BbsI/BspQI/SapI/PaqCI/AarI/BtgZI/BsmFI/FokI 等，切点在识别位点外，显示标准 (N₁/N₂) 记法）位点搜索与酶切片段计算（线性/环状） |

### 引物

| 工具 | 功能 |
| --- | --- |
| `molbio_design_primers` | **自动设计** PCR 引物对：Tm（SantaLucia 1998 NN，50 mM Na⁺/1.5 mM Mg²⁺/200 nM）、GC、GC clamp（0-3 分级）、run/发夹/自互补/二聚体约束，按 amplicon 窗口配对并排序。**v12 起结构筛查对齐 Primer3 模型**：自互补为比对分（match +1/mismatch −1/gap −0.25，阈值 8.0/3.0），发夹与引物二聚体用同一套 NN 参数折成 Tm（默认 47 °C 阈值），3' 端稳定性（末 5 碱基 ΔG(37°C) ≤ 9 kcal/mol）与末 5 碱基 GC 数。**v12 起支持错配容差**：`max_mismatches > 0` 时允许引物与模板有少量错配（3' 末端碱基绝不错配、默认避开 3' 端关键区），每处错配在 `mismatches` 中报告并计入排序罚分，精确引物总是优先。`check_mispriming: true` 检查 3' 尾在模板上的非特异结合位点并拒绝/罚分 |
| `molbio_design_intron_primers` | **跨内含子 qPCR 引物**（v10）：给定基因组序列 + 外显子坐标，正向引物跨外显子-外显子连接点（两侧各 ≥ min_junction_bases），反向引物位于另一外显子，基因组 DNA 无法扩增；`min_genomic_span` 强制最小基因组间距；输出剪接坐标 + 基因组坐标双套位置。**v12 起支持错配容差**（参数同 molbio_design_primers，错配在 spliced/genomic 双坐标下报告） |
| `molbio_primer_tm` | 单条引物 Tm 估算（Na⁺/Mg²⁺/dNTP 盐校正，von Ahsen 2001） |
| `molbio_primer_check` | 引物结构筛查：重复序列、自互补（3' 端加权）、发夹、引物对二聚体；**v12 起增加 Primer3 同款热力学指标**（self-any/self-end 比对分、发夹 Tm、二聚体 Tm、3' 端稳定性/GC） |

### 质粒

| 工具 | 功能 |
| --- | --- |
| `molbio_parse_snapgene` | **SnapGene `.dna` 文件解析**（研究者最常用的格式）：图谱名称、拓扑（环状/线形）、注释特征（类型/区段/链向/标签，支持多段 join 与 HTML 文本清洗）、序列、描述、accession、已保存引物 |
| `molbio_plasmid_map_file` | **一步成图**：直接读 `.dna`（SnapGene）或 `.gb`/`.gbk`（GenBank）文件，**把 SVG 图谱写入工作区文件**并返回 `svg_path`（默认 `<名称>.svg`，可用 `output_path` 指定） |
| `molbio_parse_genbank` | GenBank flatfile 文本解析（complement/join 定位、/gene、/product 等） |
| `molbio_plasmid_map` | 从序列 + 特征数组渲染并**直接写入 SVG 文件**（环形默认/线形可选）：特征分道、链向箭头、酶切标记、bp 刻度；同样返回 `svg_path` |

### 克隆构建

| 工具 | 功能 |
| --- | --- |
| `molbio_unique_cutters` | 克隆选酶：载体单切 + 插入零切的"理想酶"列表（可限定 MCS 区间）、区间双切酶（片段切出）、排除切插入的酶 |
| `molbio_clone_simulate` | **酶切-连接**（1-2 酶，`orientation=auto` 默认自动反向互补方向写反的插入片段）与 **Gibson 组装**（自动生成同源臂和 insert-to-order）模拟：输出最终质粒序列、特征坐标平移、连接点序列、验证酶切预测（对比空载体，单酶时含反向连接预测）；`save_path` 存 FASTA、**`map_path` 一步写出新质粒图谱 SVG**（含平移后的特征与验证酶标记） |
| `molbio_clone_primers` | 扩增引物加尾：酶切位点 + 保护碱基（内置推荐表）或 Gibson 同源臂；自动复检全长 Tm（NN 估算）/GC/二聚体，并警告"酶也切模板内部" |
| `molbio_mutagenesis_primers` | QuickChange 式定点突变引物：支持 `A123G`/`123A>G`/`123_125del`/`after123insGCT`，突变居中、G/C 端、Tm/GC/结构复检，报告氨基酸变化（frame 1 假设） |

### 克隆验证

| 工具 | 功能 |
| --- | --- |
| `molbio_verify_sanger` | 读 `.ab1`（ABIF 二进制：碱基 + 质量值）或 `.seq`/`.txt`/`.fasta` 测序文件 → 与参考质粒比对（**环状感知**，跨 origin 的读段也能对齐）→ 错配/缺失/插入报告（含质量标注）、同一性、CDS 内氨基酸后果（错义/沉默/移码） |

### 实验与统计

| 工具 | 功能 |
| --- | --- |
| `molbio_qpcr_analysis` | ΔΔCt 法：各组均值/SD、ΔCt、ΔΔCt、fold change（可设扩增效率） |
| `molbio_qpcr_efficiency` | 稀释系列 → 标准曲线：斜率/截距/R²、扩增效率 E=10^(−1/slope)−1；`plot_path` 直接写出带拟合线的 SVG 标准曲线 |
| `molbio_plot` | 通用 SVG 图表：柱状图（均值±SD 误差棒）与散点图（可选最小二乘拟合线），写成工作区文件 |
| `molbio_lab_math` | 稀释计算（C₁V₁=C₂V₂）、摩尔浓度、DNA 拷贝数 |

### 蛋白质

| 工具 | 功能 |
| --- | --- |
| `molbio_protein_props` | MW（平均残基质量）、等电点（Bjellqvist 1993 pK）、A280 消光系数（还原/全二硫键两种）、A280(0.1%)、GRAVY（Kyte-Doolittle）、脂肪族指数（Ikai 1980）——均为估算 |
| `molbio_peptide_digest` | 质谱用酶切模拟：trypsin/chymotrypsin/LysC/GluC（P 前不切规则）、漏切 0-3、单同位素/平均 [M+H]+ 质量、质量范围过滤 |
| `molbio_codon_optimize` | E. coli/酵母/人宿主密码子优化（公开发表的高频密码子表，启发式）；`avoid_enzymes` 通过同义替换尽量避开指定酶切位点 |

### 序列分析扩展

| 工具 | 功能 |
| --- | --- |
| `molbio_align` | Smith-Waterman 局部比对：可读的比对线（|/空格）、同一性%、比对区间、错配/缺失/插入列表 |
| `molbio_fasta_fastq` | 工作区 FASTA/FASTQ 处理：条目统计（长度/GC）、按 id 提取（可写 FASTA）、FASTQ→FASTA 转换、FASTQ QC（Phred 均值/低质量比例/位点质量分布） |
| `molbio_extract_region` | 从质粒文件按特征名（如 "AmpR"、"MCS"）或坐标提取子序列，可选反向互补与 FASTA 保存——克隆/设计的下游输入 |

### 图谱增强

- `molbio_plasmid_map` / `molbio_plasmid_map_file` 新增 `gc_skew: true`（GC skew 环）与 `show_unique_cutters: true`（绿色标记所有单切酶）

### 文献助手

| 工具 | 功能 |
| --- | --- |
| `molbio_pubmed_search` | 通过 harness 的 web 检索服务搜文献（自动提取 URL 中的 PMID） |
| `molbio_paper_add` | 把文献加入阅读库（默认工作区 `papers.json`，按 PMID→URL→标题+年份去重） |
| `molbio_paper_list` | 列出阅读库 |
| `molbio_paper_update` | 按 id 更新笔记/标签等字段 |
| `molbio_paper_remove` | 从阅读库删除一条文献 |

### 文献与记录

| 工具 | 功能 |
| --- | --- |
| `molbio_pubmed_abstract` | NCBI E-utilities efetch 按 PMID 拉取摘要（依赖部署提供 web fetch 能力，不支持时明确报错） |
| `molbio_paper_export_bibtex` | papers.json → BibTeX `.bib` 文件（可选按 tag 过滤） |
| `molbio_protocol_add` / `protocol_list` / `protocol_update` | 协议库（protocols.json）：步骤列表、自由参数对象、来源文献 id |
| `molbio_experiment_log` / `experiment_list` | 实验日志（experiments.json）：关联协议与文献、笔记与结果 |

## 目录结构

```
dsh-molbio-tools/
├── index.mjs        # 插件入口：export { name, inject, apply }，注册 39 个工具
├── lib.mjs          # 基础库：IUPAC、翻译、酶表、NN 热力学、qPCR、lab math
├── design.mjs       # 引物自动设计（含跨内含子 qPCR）
├── genbank.mjs      # GenBank flatfile 解析器
├── snapgene.mjs     # SnapGene .dna 二进制解析器（含极简 XML 扫描器）
├── plasmid.mjs      # SVG 质粒图谱渲染器（环形/线形，GC skew/标记）
├── align.mjs        # Smith-Waterman 局部比对 + 锚点窗口（Sanger 验证用）
├── cloning.mjs      # 克隆模拟：选酶/酶切连接/Gibson/克隆引物/突变引物
├── sanger.mjs       # ABIF (.ab1) 解析 + 测序验证报告
├── protein.mjs      # 蛋白性质/肽段酶切/密码子优化
├── plot.mjs         # SVG 柱状/散点图渲染
├── seqio.mjs        # FASTA/FASTQ 解析与统计
├── records.mjs      # 协议库/实验日志存储
├── papers.mjs       # 文献库存储（经 harness fs 服务 + 沙箱政策）
├── cordis.patch.yml # bundle 补丁层（可选安装渠道用，按包名插入 tool-molbio 行）
├── preset/
│   └── molbio-lab/  # 推荐的专属模式预设（agent.cordis.yml + preset.yml + plugins/dsh-molbio-tools-v13/）
├── test/
│   └── smoke.mjs    # 冒烟测试（复用 harness 自身的 JSON Schema 校验器）
├── docs/
│   └── maintainer.md # 维护者文档（合规对照/开发测试/路线图）
├── package.json
└── README.md
```

## 安装（推荐：专属模式 preset）

**推荐给最终用户的方式**：安装后预设选择器出现 **Molecular Biology Lab** 专属模式，
molbio 工具只在该模式出现，不会把 39 个工具和提示段注入到其它会话（避免污染无关场景）。

仓库的 `preset/molbio-lab/` 即完整预设目录，把它复制到对方的 harness 用户目录即可：

```
~/.dsh/.agent-presets/molbio-lab/
├── agent.cordis.yml                 # 标准编码 Agent + 末尾的 tool-molbio 行
├── preset.yml                       # 显示名称与描述
└── plugins/
    └── dsh-molbio-tools-v13/        # 插件文件（版本目录，见下文）
```

对方重启（或刷新预设列表）后，在预设选择器中选择 **Molecular Biology Lab** 新建会话。

### 插件更新（版本目录规则）

DSH 的 standing 挂载按 ESM 模块 URL 缓存模块。**每次更新必须新建版本目录**
（如 `dsh-molbio-tools-v13/`）并同步修改 `agent.cordis.yml` 中的插件行；绝不在已发布
目录里原地改文件。分发者从包根目录把 `.mjs` 文件复制进新版本目录即可：

```
cp *.mjs preset/molbio-lab/plugins/dsh-molbio-tools-v13/
# 并把 agent.cordis.yml 的行改为 './plugins/dsh-molbio-tools-v13/index.mjs'
```

## 安装（可选：官方组合包 bundle，全局可见）

本包同时是官方的**组合包（bundle）**（`dsh.bundle` manifest → `cordis.patch.yml`）。
注意：bundle 把插件行注册到 profile 的**全局 tools 层——该 profile 的所有会话都会
加载 molbio 工具与提示段**。适合"整个 profile 专用于分子生物学"的用户，不适合混合用途。

| 方式 | 命令 | 用户安装 |
| --- | --- | --- |
| GitHub | 推送到仓库 | `dsh plugin --profile <name> add github:lovy2004/dsh-molbio-tools`（纯 JS 零构建，无需 prepare 脚本与构建授权） |
| npm 发布 | `npm publish` | `dsh plugin --profile <name> add dsh-molbio-tools` |
| tarball | `pnpm pack` | `dsh plugin --profile <name> add ./dsh-molbio-tools-0.1.0.tgz` |

验证方式（官方推荐）：

```
dsh plugin --profile demo add <包>      # 需要用户机器装有 pnpm（官方流程依赖）
dsh --profile demo --dump-config        # 组合树中应出现 "# == dsh-molbio-tools" 层
```

本仓库已验证：`--dump-config` 输出以 `# == dsh-molbio-tools` + `- id: tool-molbio / name: dsh-molbio-tools` 开头（层序在 dsh-base 之上），且从 profile 目录按包名
`import('dsh-molbio-tools')` 成功注册全部 39 个工具。两种安装方式可以共存（同名工具
由 preset 层 shadow 全局层，无冲突），但通常**二选一**即可。

> **版本目录规则的原理**（维护者必读）：DSH 的 standing preset 挂载在整个进程生命周期
> 内存在，且 Node 的 ESM 模块缓存以文件 URL 为键——同一 URL 的 `import()` 永远返回
> 第一次加载的模块，**包括插件内部的相互 import**（给入口加查询串只能破坏入口自身的
> 缓存，依赖文件仍会命中旧缓存）。因此原地替换 `.mjs` 不会让新会话加载新代码；目录名
> 变化使所有模块 URL 一次性更新。旧目录可删除（已运行的 generation 持有内存中的模块，
> 不受磁盘删除影响）。

## 行为与假设


- **纯计算工具**（序列/引物/统计）确定性、无副作用；输入输出均为可持久化的 JSON。
- **图谱工具直接写文件**：`molbio_plasmid_map` / `molbio_plasmid_map_file` 把 SVG 写入工作区（`ctx.fs` + 会话沙箱政策），模型上下文里只出现文件路径，避免大文本截断。
- **克隆模拟约定**：酶切-连接要求"插入片段按 5'→3' 书写、上游酶在 5' 端"；单酶连接会给出双向连接说明与两种方向的验证酶切；特征坐标按插入/缺失自动平移，跨越连接点的特征标注 `spans_insertion`。
- **Sanger 验证**：参考序列按环状处理（读段跨 origin 也能正确对齐）；`.ab1` 低质量（<20）位点单独标注且不计入"differences_found"判定；氨基酸后果按 frame 1 假设报告。
- **文献库与检索**走 harness 的 `fs`/`web` 服务：库文件默认 `papers.json` 在工作区内，写入遵循会话的沙箱政策（`ctx.sandboxPolicy`），与其他文件工具同权。
- **IUPAC 序列**：输入支持 `A C G T U R Y S W K M B D H V N`；`U` 按 `T` 处理；简并碱基在酶切位点匹配与引物设计中视为不匹配/不可用。
- **Tm 是估算值**：SantaLucia 1998 NN + 盐校正，报告时应说明是估算，不能替代仪器校准。
- **图谱坐标**：特征 1-based 闭区间；`strand: -1` 表示 complement 链；酶切标记使用酶表的标准切点记号。
- **引物设计性能**：区域扫描 + 候选缓存 + 排序裁剪，几十 kb 模板在亚秒级完成；找不到满足约束的组合时返回空并提示放宽条件。
- **错配容差（v12）**：`max_mismatches > 0` 时，若某窗口没有精确引物通过全部约束，设计器用**最少的替换**尝试挽救（只针对可修复的约束：GC 失衡、run、Tm 微差）。3' 末端碱基永远不错配，默认在 3' 端 `mismatch_3prime_zone`（默认 5 bp）关键区内也不放错配（`max_3prime_mismatches` 可放宽）。每处错配逐条报告：引物内位置、模板位置、模板碱基/引物碱基、距 3' 端距离；每个错配都会加重排序罚分——存在精确引物时精确引物永远优先。
- **Primer3 对齐的结构筛查（v12）**：自互补（self-any/self-end）为比对分（match +1 / mismatch −1 / gap −0.25，阈值 8.0/3.0）；发夹与引物二聚体（any/end）用与 Tm 相同的 SantaLucia NN 参数折成 Tm（默认阈值 47 °C，`max_hairpin_tm`/`max_dimer_tm`/`max_dimer_end_tm`）；3' 端稳定性 = 末 5 碱基的 ΔG(37 °C)（`max_end_stability`，默认 9 kcal/mol）；末 5 碱基 GC 数（`max_end_gc`，默认 5）；GC clamp 为 0-3 连续 G/C 分级（`gc_clamp`，默认 1，`require_gc_clamp` 为兼容别名）。数值均为估算，与 Primer3 同量纲便于互相校验。
- **非特异结合检查（v12）**：`check_mispriming: true` 时，按 k-mer 索引检查每条引物 3' 尾（默认 8 bp、允许 1 个错配且末端碱基必须配对）在模板双链上的额外退火位点；超过 `mispriming_max_sites` 的引物对被拒绝，其余按位点数罚分并在 `mispriming_sites` 中报告位点与链向。

## 典型用法示例

```
"解析这个 .dna 文件并画出质粒图谱"        → molbio_plasmid_map_file(path, enzymes:[...]) → 工具直接写入 <名称>.svg
"看看 pUC118.dna 里有哪些特征和引物"      → molbio_parse_snapgene(path)
"把这段序列克隆进 pUC118（EcoRI/HindIII），模拟最终质粒" → molbio_unique_cutters 选酶 → molbio_clone_simulate → molbio_plasmid_map 画新质粒
"给插入片段设计带酶切位点的克隆引物"      → molbio_clone_primers
"帮我验证这个测序结果和质粒是否一致"      → molbio_verify_sanger(trace_path, reference_path)
"帮我在外显子 3 上设计一对 qPCR 引物，产物 80-150 bp" → molbio_design_primers (amplicon_min/max) → molbio_primer_check 复核
"搜一下 KRAS G12D 抑制剂的最新文献并存进阅读库" → molbio_pubmed_search → molbio_paper_add
```

### SnapGene .dna 支持说明

- 解析器支持现代 SnapGene 格式（cookie + DNA 包 + XML 包：features 0x0A、primers 0x05、notes 0x06）；序列编码自动检测（ASCII 与旧式数字编码）；环状/线形由 DNA 包 flags 推断。
- 特征区段支持多段 join（如 AmpR 的编码区 + 信号肽），`directionality` 映射为链向（1→正链，2→负链）。
- SnapGene 注释里的 HTML 文本（`&lt;html&gt;…`）会自动清洗为纯文本。
- `.dna` 是二进制文件，普通 read 工具读不了——请直接给工具传文件路径，不要尝试自己读内容。

---

维护者（开发者）请参阅 [docs/maintainer.md](docs/maintainer.md)：官方规范对照、冒烟测试与发布/版本目录维护流程。
