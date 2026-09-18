# dsh-molbio-tools

**给 AI 助手装上分子生物学的"手"**：一个零依赖的 DeepSeek Harness 插件包，为它提供 **57 个
`molbio_*` 工具**——序列分析、引物/探针自动设计、克隆模拟、质粒图谱、测序验证、蛋白与 CRISPR
分析、qPCR 统计、文献与实验记录。装上之后，你可以直接用自然语言让助手完成这些计算，并把结果
画成图。

例如，下面这些都是可以**直接说给它听**的请求：

```
"解析这个 pUC118.dna，画一张质粒图谱，标出 EcoRI/HindIII 的切点"
"帮我在这段基因上设计一对 qPCR 引物，产物 80–150 bp，Tm 60 左右"
"这 4 对引物能放同一个多重 PCR 里吗？帮我看二聚体和扩增子大小"
"我用 EcoRI+HindIII 双酶切，这两个酶能共用一个 buffer 吗？"
"酶切切不动，是不是 Dam 甲基化挡了？"
"给这个基因设计一套 TaqMan 测定，探针 Tm 要比引物高 5 度"
"把这三条同源序列对齐，找出保守区，画成 sequence logo"
"在这段序列里找 SpCas9 的 gRNA，脱靶越少越好"
"把这段肽画成螺旋轮，看看是不是两亲性；再画个疏水性图找跨膜段"
"验证这个 .ab1 测序结果和参考质粒是否一致"
```

想要它**自己看一眼**画出来的图（比如核对凝胶条带位置），在调用时加 `attach_image: true`：
图会作为图片附件直接挂到结果上（见[让模型自己看图](#让模型自己看图attach_image可选默认关)）。

> 这是个实验台助手，不是数据库：**它做计算、写文件、画图，不替你判断生物学结论。** 所有 Tm、
> 效率、评分都是可复核的估算值（每节都写明用的是哪套模型），最终实验设计仍要你自己把关。

---

## 目录

- [安装](#安装)（3 步）
- [它会做什么](#它会做什么)（按任务分组的 57 个工具）
- [典型用法示例](#典型用法示例)
- [输出文件、自动打开与浏览器面板](#输出文件自动打开与浏览器面板)
- [方法学与使用须知](#方法学与使用须知)（各工具的模型、估算范围与边界）
- [常见问题](#常见问题)
- [开发者入口](#开发者入口)

---

## 安装

需要一台已装好 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) 的机器。

### 推荐：专属模式 preset（3 步）

装完后，预设选择器里会出现 **Molecular Biology Lab** 模式；**57 个工具只在这个模式里出现**，
不会污染你其它会话（这点很重要：工具多了会占提示预算）。

```powershell
# 1. 把包装进你的 profile（web 是默认 profile 名，按需替换）
dsh plugin --profile web add D:\path\to\dsh-molbio-tools

# 2. 把包内的 preset 注册进该 profile（幂等；--check 可当体检，--dry-run 只打印）
node D:\path\to\dsh-molbio-tools\preset\install.mjs --profile web

# 3. 重启该 profile，然后在预设选择器里选 "Molecular Biology Lab" 新建会话
```

以后升级只要一条命令，**不用重新复制、也不用改配置**（第 2 步只需做一次）：

```powershell
dsh plugin --profile web update dsh-molbio-tools
```

### 备选：复制 preset 目录（可离线带走）

把仓库里的 `preset/molbio-lab/` 整个复制到 `~/.dsh/.agent-presets/molbio-lab/`，重启后即可在
选择器里看到该模式。适合无法改 profile 配置的环境；代价是**每个新版本都要重新复制**到新的
`vN` 目录（同一目录原地覆盖不会生效，原因见 [开发者入口](#开发者入口)）。

### 备选：bundle 安装（工具对该 profile 全局可见）

```powershell
dsh plugin --profile <name> add github:lovy2004/dsh-molbio-tools   # 或 npm 上的包名 / 本地 tarball
dsh --profile <name> --dump-config                                 # 组合树里应出现 "# == dsh-molbio-tools"
```

bundle 会把工具注册到该 profile 的**全局层——所有会话都会加载**。只有"整个 profile 专做
分子生物学"时才推荐；混合用途请用上面的 preset 方式。

### 只要浏览器面板（可选）

如果只想要图形面板、不想把 57 个工具带进每个会话，装面板专用包即可（见
[浏览器面板](#浏览器面板)）：

```powershell
dsh plugin --profile <profile> add D:\path\to\dsh-molbio-tools\packages\molbio-panel
```

---

## 它会做什么

57 个工具按任务分为十组。下表是"你想做什么 → 用哪个工具"的索引，参数细节模型会在调用时自己
填；你只需要把意图说清楚。

### 1. 序列分析与酶切（7）

| 工具 | 用途 |
| --- | --- |
| `molbio_reverse_complement` | 反向互补 / 互补链（支持 IUPAC 简并码） |
| `molbio_gc_content` | GC 含量，可选分窗口 GC 曲线 |
| `molbio_translate` | 1/2/3/−1/−2/−3 或六框翻译（3 套密码子表）、ORF 查找 |
| `molbio_restriction_sites` | **90+ 限制酶**位点搜索与酶切片段计算（线性/环状），含 IIS 型酶（BsaI/BsmBI/BbsI/BspQI/SapI/PaqCI/AarI/FokI…，显示标准 (N₁/N₂) 切点记法） |
| `molbio_enzyme_lookup` | 酶目录查询：识别位点/切点几何/突出端长度；给序列时报告**双链向的全部切点**（IIS 酶的反向识别位点也会被切，这是上一个工具不报告的） |
| `molbio_methylation_check` | **甲基化会不会挡住酶切**：列出序列中每个 Dam（GATC）/Dcm（CCWGG）位点，把每个酶判为 `cuts` / `impaired` / `blocked` / `no_site`，并给出"哪些酶能用来切"的清单 |
| `molbio_double_digest` | **双酶切规划**：两个酶各自的切点/片段、合并切点与片段，以及两者**是否共用 buffer**（无共用则提示顺序酶切或换用厂商双酶切 buffer） |

### 2. 引物设计（6）

| 工具 | 用途 |
| --- | --- |
| `molbio_design_primers` | **自动设计 PCR 引物对**：Tm（SantaLucia 1998 最近邻模型，盐/浓度可调）、GC、GC clamp、run/发夹/自互补/二聚体约束、错配容差、非特异结合检查、3' 目标位置偏好（SNP/定点设计），按罚分排序给出多组候选 |
| `molbio_design_intron_primers` | **跨内含子 qPCR 引物**：给定基因组序列 + 外显子坐标，正向引物跨外显子-外显子连接点，基因组 DNA 不会扩增（可设最小基因组间距） |
| `molbio_design_taqman` | **TaqMan（水解探针）测定设计**：引物对 + 探针一次给出（探针 5' 端非 G、Tm 比引物高 5 °C 起、无 run/重复、不与引物二聚化），每条候选附逐项罚分 |
| `molbio_primer_tm` | 单条引物 Tm 估算（Na⁺/Mg²⁺/dNTP 盐校正） |
| `molbio_primer_check` | 引物结构筛查：重复序列、3' 端加权的自互补、发夹、引物对二聚体，以及 Primer3 同款热力学指标 |
| `molbio_multiplex_check` | **多重 PCR 互扰检查**：面板内所有引物对的二聚体、3' 尾的脱靶与跨模板退火、扩增子是否能在胶上分辨，并给出重设计建议 |

### 3. 质粒与图谱（4）

| 工具 | 用途 |
| --- | --- |
| `molbio_parse_snapgene` | 解析 **SnapGene `.dna`**（图谱名称、拓扑、注释特征、序列、描述、accession、已保存引物） |
| `molbio_parse_genbank` | 解析 GenBank flatfile（complement/join 定位、`/gene`、`/product` 等） |
| `molbio_plasmid_map_file` | **一步成图**：直接读 `.dna`/`.gb`/`.gbk` → 把 SVG 图谱**写入工作区**并自动打开 |
| `molbio_plasmid_map` | 从序列 + 特征数组渲染环形/线形图谱（可选 GC skew 环、单切酶标记） |

### 4. 克隆构建（6）

| 工具 | 用途 |
| --- | --- |
| `molbio_unique_cutters` | 克隆选酶：载体单切 + 插入零切的"理想酶"列表（可限定 MCS），也列区间双切酶 |
| `molbio_clone_simulate` | **酶切-连接**（1–2 酶，自动纠正反向插入）与 **Gibson 组装**模拟：最终质粒序列、特征坐标平移、连接点、验证酶切，可直接存 FASTA 与图谱 |
| `molbio_golden_gate` | **Golden Gate 多片段组装**：自动设计 4 bp 突出端、检查酶不切片段、给出可直接下单的片段序列、拼出最终质粒 |
| `molbio_clone_primers` | 给插入片段加酶切位点 + 保护碱基（内置推荐表）或 Gibson 同源臂，并复检全长 Tm/GC/二聚体 |
| `molbio_mutagenesis_primers` | QuickChange 式定点突变引物（`A123G`/`123A>G`/`123_125del`/`after123insGCT`），报告氨基酸变化 |
| `molbio_extract_region` | 从质粒文件按特征名（如 "AmpR"、"MCS"）或坐标提取子序列，可选反向互补与存 FASTA |

### 5. 测序与实验数据（6）

| 工具 | 用途 |
| --- | --- |
| `molbio_verify_sanger` | 读 `.ab1`（含碱基质量值）或 `.seq`/`.txt`/`.fasta` → 与参考质粒比对（**环状感知**）→ 错配/缺失/插入报告（含质量标注）、同一性、CDS 内氨基酸后果 |
| `molbio_qpcr_analysis` | ΔΔCt 法：均值/SD、ΔCt、ΔΔCt、fold change（可设扩增效率） |
| `molbio_qpcr_efficiency` | 稀释系列 → 标准曲线：斜率/截距/R²、效率 E = 10^(−1/slope) − 1，可出带拟合线的 SVG |
| `molbio_lab_math` | 稀释计算、摩尔浓度、DNA 拷贝数 |
| `molbio_plot` | 通用 SVG 图表：柱状图（均值±SD 误差棒）与散点图（可选拟合线） |
| `molbio_virtual_gel` | **虚拟琼脂糖凝胶**：给出预期片段大小 → SVG 凝胶图 + 分子量 ladder，和真胶对照 |

### 6. 蛋白质（5）

| 工具 | 用途 |
| --- | --- |
| `molbio_protein_props` | MW、等电点、A280 消光系数、A280(0.1%)、GRAVY、脂肪族指数 |
| `molbio_peptide_digest` | 质谱用酶切模拟：trypsin/chymotrypsin/LysC/GluC（P 前不切）、漏切 0–3、[M+H]⁺ 质量 |
| `molbio_codon_optimize` | E. coli/酵母/人密码子优化，可顺便避开指定酶切位点 |
| `molbio_helical_wheel` | **螺旋轮投影**：残基按 3.6 残基/圈落在圆周上、按性质着色，给出疏水矩 μH（判断是否两亲性），出 SVG |
| `molbio_hydropathy_plot` | **Kyte-Doolittle 疏水性图**：滑动窗口曲线 + GRAVY + 达到跨膜阈值的峰，出 SVG |

### 7. 比对与保守性（5）

| 工具 | 用途 |
| --- | --- |
| `molbio_align` | Smith-Waterman 局部比对：可读的比对线、同一性%、比对区间、错配/缺失/插入列表 |
| `molbio_msa_align` | **多序列比对**（2–50 条 IUPAC DNA）：渐进式比对，返回比对结果与两两同一性 |
| `molbio_conservation` | **保守性分析**：共识序列、逐列 identity、熵基保守性打分、保守/可变位点统计 |
| `molbio_sequence_logo` | **序列标识图**：把保守性画成 SVG logo（字母高度 = 信息量 bits） |
| `molbio_fasta_fastq` | 工作区 FASTA/FASTQ：条目统计、按 id 提取、FASTQ→FASTA、FASTQ 质量报告 |

### 8. CRISPR（1）

| 工具 | 用途 |
| --- | --- |
| `molbio_grna_design` | **gRNA 设计**（默认 SpCas9 `NGG` PAM）：双链扫描、GC/poly-T/自互补/发夹等质量指标、逐项公开的启发式评分，以及**同序列内的错配容差脱靶搜索**（种子区不许错配）；可出订购 CSV 与带标记的图谱 |

### 9. 文献与实验记录（12）

| 工具 | 用途 |
| --- | --- |
| `molbio_pubmed_search` | 通过 harness 的 web 检索服务搜文献，自动提取 PMID |
| `molbio_pubmed_abstract` | 按 PMID 拉取摘要（依赖部署提供 web fetch 能力） |
| `molbio_paper_add` / `molbio_paper_list` / `molbio_paper_update` / `molbio_paper_remove` | 阅读库（工作区 `papers.json`）：加/列/改/删，按 PMID→URL→标题+年份去重 |
| `molbio_paper_export_bibtex` | `papers.json` → BibTeX `.bib`（可按 tag 过滤） |
| `molbio_protocol_add` / `molbio_protocol_list` / `molbio_protocol_update` | 协议库（`protocols.json`）：步骤列表、自由参数、来源文献 |
| `molbio_experiment_log` / `molbio_experiment_list` | 实验日志（`experiments.json`）：关联协议与文献、笔记与结果 |

### 10. 实验台分析（5，v19 新增）

| 工具 | 用途 |
| --- | --- |
| `molbio_fastq_qc` | **读级 FASTQ 质控**：每碱基质量（均值 **+ 四分位**）、每读质量直方图、每碱基 A/C/G/T 含量、每读 GC 分布（含理论正态叠加）、长度分布、**精确序列重复率**、过度代表序列、内置接头片段扫描、Q20/Q30 与"质量从第几位开始跌破 Q30"——并出一张六面板 SVG 报告 |
| `molbio_codon_usage` | **密码子使用分析**：CAI（Sharp & Li）、逐密码子 RSCU、Nc（有效密码子数）、GC3/GC123、罕见密码子清单（带位置与宿主频率）、CDS 内 CpG 观测/期望、隐藏终止子扫描；可对比 E. coli / 酵母 / 人 |
| `molbio_phylogenetic_tree` | **距离法系统发生树**：p-distance / Jukes-Cantor / Kimura 2P / Tamura-Nei 校正距离、UPGMA 或邻接法（NJ）、**bootstrap 支持度（种子可复现）**、严格/多数共识树、Newick 读写、矩形式/环形/扇形 SVG |
| `molbio_pcr_simulate` | **in-silico PCR**：双链搜索引物结合位点、产物大小与坐标、逐位错配明细、**"3' 端必须精确匹配几个碱基"是独立旋钮**（中段错配仍能延伸、3' 错配通常不能）、环状模板跨 origin 产物、对额外模板（如载体）做错引导筛查、预期凝胶图 |
| `molbio_gc_composition` | **GC 组成与 CpG 岛**：滑窗 GC、CpG 岛（Gardiner-Garden 1987 或 Takai & Jones 2002 两套阈值）、GC/AT skew 与**累积 skew**（复制起点/终点的经典指示）、二核苷酸观测/期望、词频、Shannon 熵、语言复杂度、N50/L50，出三面板图 |

---

## 典型用法示例

直接对助手说人话即可；下表是"你说什么 → 它背后做什么"的对照，方便你在结果不理想时知道该调哪个
旋钮。

| 你说 | 会发生什么 |
| --- | --- |
| "解析这个 `.dna` 并画出质粒图谱" | `molbio_plasmid_map_file(path, enzymes:[…])` → 工具自己写入 `<名称>.svg` 并打开 |
| "看看 pUC118.dna 里有哪些特征和引物" | `molbio_parse_snapgene(path)` |
| "把这段序列克隆进 pUC118（EcoRI/HindIII）" | `molbio_unique_cutters` 选酶 → `molbio_clone_simulate` → 直接画新质粒图谱 |
| "用 BsaI 把三个片段 Golden Gate 装进载体" | `molbio_golden_gate(vector, inserts:[…], replace_region:{…})` → `fragments_to_order` 下单 + 图谱 |
| "载体里 BsaI 会不会把插入片段切了？" | `molbio_enzyme_lookup(sequence, enzymes:['BsaI'])` |
| "酶切该出哪几条带？画个图" | `molbio_restriction_sites` → `molbio_virtual_gel(lanes:[{fragments}])` |
| "酶切切不动，是不是甲基化挡了？" | `molbio_methylation_check(sequence)` → 看 `blocked` / `impaired` / `usable` |
| "EcoRI+HindIII 能共用一个 buffer 吗？" | `molbio_double_digest(sequence, first:'EcoRI', second:'HindIII', circular:true)` |
| "设计一对 qPCR 引物，产物 80–150 bp" | `molbio_design_primers(amplicon_min/max)` → `molbio_primer_check` 复核 |
| "在外显子 3 上设计 qPCR 引物，别扩到基因组" | `molbio_design_intron_primers(genomic, exons)` |
| "这几对引物能放同一个多重 PCR 吗？" | `molbio_multiplex_check(targets:[…])` → 看 dimer / 跨模板退火 / 大小冲突 |
| "设计一套 TaqMan 测定，探针 Tm 高 5 度" | `molbio_design_taqman(sequence)` → 看 `probe.tm_delta_vs_primer` 与 `notes` |
| "验证这个测序结果和质粒一致吗" | `molbio_verify_sanger(trace_path, reference_path)` |
| "把这几条同源序列对齐，找保守区和可变位点" | `molbio_msa_align` → `molbio_conservation(alignment: …)`（也可直接给 `sequences`） |
| "把这段启动子的保守性画成图" | `molbio_sequence_logo(alignment: … 或 sequences: […])` |
| "在这个基因里找 SpCas9 的 gRNA，脱靶越少越好" | `molbio_grna_design(sequence 或 .dna 路径)` → `save_path` 出订购 CSV / `map_path` 出图谱 |
| "这段肽是不是两亲性？画个螺旋轮" | `molbio_helical_wheel(sequence, moment_window:11)` |
| "画这个蛋白的疏水性图，找跨膜段" | `molbio_hydropathy_plot(sequence, window:19)` |
| "这批测序数据质量怎么样，从第几位开始掉" | `molbio_fastq_qc(path)` → 看 `quality_tail_below_30` 与六面板报告 |
| "这个基因在大肠杆菌里表达会好吗，问题在哪" | `molbio_codon_usage(sequence, host:'e_coli')` → CAI / 罕见密码子清单 |
| "这对引物除了目标还会在哪扩增？预期几条带" | `molbio_pcr_simulate(template, primer_pairs:[…])` → 产物大小 + 凝胶图 |
| "这几条序列谁跟谁最近，这个结论有信心吗" | `molbio_phylogenetic_tree(sequences:[…], bootstrap:100)` → 支持度 + Newick |
| "这段是不是启动子/CPG 岛？复制起点在哪" | `molbio_gc_composition(sequence)` → CpG 岛区间 + 累积 GC skew 的 ori/ter 提示 |
| "搜一下 KRAS G12D 抑制剂的最新文献并存进阅读库" | `molbio_pubmed_search` → `molbio_paper_add` |

---

## 输出文件、自动打开与浏览器面板

### 图片与文件写到工作区

序列、图谱、凝胶、曲线这类**图**不塞进对话（大段 SVG 会被截断），而是由工具**直接写成工作区里的
SVG 文件**并在结果里返回路径：

| 工具 | 产物 |
| --- | --- |
| `molbio_plasmid_map` / `molbio_plasmid_map_file` | `<名称>.svg`（默认） |
| `molbio_clone_simulate` / `molbio_golden_gate` | `map_path`（图谱）、`save_path`（FASTA） |
| `molbio_sequence_logo` / `molbio_grna_design` | logo SVG；订购 CSV 与带标记图谱 |
| `molbio_qpcr_efficiency` / `molbio_plot` / `molbio_virtual_gel` | 曲线、柱状/散点图、凝胶图 |
| `molbio_helical_wheel` / `molbio_hydropathy_plot` | 螺旋轮、疏水性图 |
| `molbio_fastq_qc` | `<名称>.qc.svg`（六面板质控报告） |
| `molbio_phylogenetic_tree` | `<名称>.nwk`（Newick）+ `<名称>-tree.svg` |
| `molbio_pcr_simulate` | `pcr-gel.svg`（预期凝胶） |
| `molbio_gc_composition` | `gc-composition.svg`（GC/CpG 三面板图） |
| `molbio_fasta_fastq` / `molbio_extract_region` / `molbio_paper_export_bibtex` | FASTA / `.bib` |

### 让模型自己看图：`attach_image`（可选，默认关）

上面这些**画图工具**（共 15 个）都接受一个可选参数 **`attach_image: true`**。打开后，工具会把
同一张图**当场光栅化成 PNG 并作为图片附件挂到这次调用的结果上**——模型因此能直接"看见"凝胶
条带、质粒图谱、logo、螺旋轮、曲线，而不是只能读数值。传了就会在结果里回一个 `image` 对象
（附件的 id/尺寸/字节数），文本里也会写明"图已附上"。

```text
molbio_virtual_gel(lanes=[...], attach_image=true)   # 模型看得见这张胶
molbio_plasmid_map_file(path="pUC118.dna", attach_image=true)
```

为什么是"附件"而不是写出一个 `.png` 文件？**harness 的文件系统接口按契约只写文本**
（`dsh-fs` 对二进制返回 `FS_NOT_TEXT`，其写入路径把字符串按 UTF-8 落盘，"binary-safe
mutations remain deferred"）。所以插件无法在工作区里合法地落一个 PNG 文件——绕开它就只能
直接 `node:fs` 或用子进程写盘，那会逃出会话沙箱政策，本包不做。附件是 harness 自己提供的
**二进制安全**通路（`ctx.attachments.saveImage` + 工具结果里的 image block，也是它自带
`read_image` 工具用的同一条路）。

想拿 PNG 文件的话，SVG 仍然是标准产物（照写、照自动打开），可以在本地转一次格式。

**降级而不是报错**：这一步是"额外好处"，任何一环不满足都会静默退回纯文本，并在结果里用
`image_note` **说明原因**——没有挂附件服务、当前路由的模型不声明图像输入（例如纯文本模型）、
绘图器渲染不了这份文档、附件存储拒收。**图没附上时工具依然成功、SVG 依然写好**；调用本身
永远不会因为图片失败。

关于 PNG 本身的诚实边界：它由本包内置的**折线字体**绘制（无字体文件、无外部依赖），字形是
矢量描边、随字号缩放；可绘制 ASCII 与 `· ° ± — – … ≈ μ α ─`，**中文/其它非 ASCII 字符不会
画出来**（图谱标题若是中文，PNG 里就缺这行字，SVG 里仍有）。渲染器不支持的 SVG 构造会被
**计数上报**而不是悄悄丢弃（`unsupported`），相关测试盯着"真实渲染器的产物必须在支持子集内"。

### 自动打开（auto-view）

**所有生成 SVG 的工具写完文件后会自动用系统默认应用打开**（Windows `Invoke-Item`、macOS `open`、
桌面 Linux `xdg-open`/`$BROWSER`、WSL 自动转译路径），所以你通常不用去翻文件。结果里的
`auto_viewed` 字段告诉你是否打开成功。

- 不想弹窗：每次调用都能传 `auto_view: false`；
- 无桌面环境（headless Linux）会自动跳过；
- 想全局关掉：设环境变量 `MOLBIO_AUTO_VIEW=0`。

### 浏览器面板（可选）

除了"写文件 + 系统查看器"这条链路，本包还带**浏览器内的右栏面板与图谱调用卡**：

| 落点 | 内容 |
| --- | --- |
| **Molbio**（右栏 tab） | 列出当前会话工作区的序列文件，选中**当场在面板里画出来**：`.dna`/`.gb`/`.gbk` 出质粒图谱 + 特征表，`.fa`/`.fasta` 出序列标识图 |
| **Papers**（右栏 tab） | 把 `papers.json` 渲染成可搜索的阅读列表（标题直达 PubMed/原 URL） |
| **图谱调用卡**（对话内） | 画图谱的工具**直接在对话里画出这次产出的图谱**，不必再去开文件 |

它走 bundle 渠道（安装见[只要浏览器面板](#只要浏览器面板)）；装上后**重启一次服务并刷新页面**。
与 preset 渠道可以共存：preset 给工具，bundle 给面板。细节与已知限制见
[docs/client-panel.md](docs/client-panel.md)。

若升级后顶栏出现 **Failed to load plugins**，那是某个客户端插件在启动时抛了异常（不是"面板没
挂上"）。先 `dsh plugin --profile <profile> remove <包>` 止血，排查顺序见
[docs/maintainer.md](docs/maintainer.md) 的"UI 起不来"一节。

---

## 方法学与使用须知

这一节是**读结果时的参考**：每个工具用的是哪套模型、哪些是估算、哪些边界要注意。摘要版：

- **纯计算**：除文献检索/摘要（走 harness 的 web 服务）与文件读写（走 harness 的 fs 服务 +
  会话沙箱政策）外，所有工具都是确定性、无副作用的计算。
- **Tm 全是估算**：SantaLucia 1998 最近邻模型 + 盐校正（von Ahsen 2001），不能替代仪器校准。
- **引物设计可调**：`na_mm`/`mg_mm`/`dntp_mm`/`primer_nm`（默认 50 / 1.5 / 0.8 / 200）直接驱动
  Tm 盐校正与发夹/二聚体折叠浓度；输出里的 `conditions` 会回显实际用的条件。
- **评分是排序用的启发式**：CRISPR gRNA 评分、引物排序罚分都**不是**效率/特异性预测值。
- **甲基化与 buffer 表是速查表**：手工转录的参考数据，用前请对照厂商当前表格。
- **比对是启发式**：MSA 的渐进比对与保守性打分用于比较，不是系统发育真值。

### 序列输入

- IUPAC 简并码：`A C G T U R Y S W K M B D H V N`；`U` 按 `T` 处理；空白与数字自动忽略。
- 简并碱基在**酶切位点匹配**与**引物设计**中视为不匹配/不可用（不会"猜"）。
- 坐标约定：特征与切点均为 **1-based 闭区间**；`strand: -1` 表示 complement 链。
- `.dna` 是二进制文件，普通读文件工具读不了——直接给工具传**路径**即可。

### 引物设计的模型与边界

- **结构筛查对齐 Primer3**：自互补（self-any/self-end）用比对分（match +1 / mismatch −1 /
  gap −0.25，阈值 8.0/3.0）；发夹与引物二聚体用与 Tm 相同的 NN 参数折算成 Tm（默认阈值
  47 °C，`max_hairpin_tm`/`max_dimer_tm`/`max_dimer_end_tm`）；3' 端稳定性 = 末 5 碱基的
  ΔG(37 °C)（`max_end_stability`，默认 9 kcal/mol）；末 5 碱基 GC 数（`max_end_gc`，默认 5）；
  GC clamp 为 0–3 级（`gc_clamp`，默认 1，`require_gc_clamp` 为兼容别名）。
- **错配容差**（`max_mismatches > 0`）：某窗口没有精确引物通过全部约束时，设计器用**最少的替换**
  尝试挽救（只针对可修复的约束）。3' 末端碱基永远不错配，默认在 3' 端 `mismatch_3prime_zone`
  （默认 5 bp）内也不放错配。每处错配逐条报告并加重罚分——**有精确引物时精确引物永远优先**。
- **非特异结合检查**（`check_mispriming: true`）：按 k-mer 索引检查每条引物 3' 尾（默认 8 bp、
  允许 1 个错配且末端碱基必须配对）在模板**双链**上的额外退火位点；超过 `mispriming_max_sites`
  的引物对被拒绝。
- **目标位置偏好**（`target_position` + `target_penalty`）：按"较近引物 3' 端到目标的距离"加重
  罚分，用于 SNP 分型/定点设计；跨内含子设计里该坐标是**剪接坐标**。
- **性能**：几十 kb 模板在亚秒级完成；找不到满足约束的组合时返回空并提示放宽条件。

### TaqMan 探针（v17）

- 几何按"**扩增子缺口**"建模：扩增子有左右两个缺口，每个引物的 3' 端朝向其中一个；探针从
  **开缺口的那个引物**向外读。`orientation: "forward"`（顶链，标准设计）读的是正向引物那一侧的
  缺口，`"reverse"` 读另一侧并报反向互补——按报告的方向直接下单即可。
- 探针必须落在缺口内、**不与任一引物结合位点重叠**，且与开缺口引物 3' 端至少留
  `probe_min_distance_from_primer`（默认 1 bp）；`distance_from_primer_3prime` 报的就是这个距离。
- 硬过滤：5' 端非 G、3' 端非 G（`allow_3prime_g` 可放开）、无过长单碱基重复、无串联重复、
  自互补有界。
- **扩增子默认 70–200 bp**（水解探针测定的常规尺寸）；用 `primer_options` 透传引物引擎的
  snake_case 键（`region_start`/`tm_min`/`amplicon_max`/`na_mm`…），未知键会明确报错。
- `tm_delta_vs_primer`（探针 Tm − 较热引物 Tm）为负时探针仍会给出，但在 `notes` 里点名该
  扩增子——看到这条就说明这套测定该换个区域。

### 多重 PCR 互扰（v17）

- 面板内**所有**引物对都算二聚体；同一 target 内正向+反向是设计时已校验的预期配对，不冲突时
  不报告（冲突时照样报）。
- 非预期退火分两类：**自身模板的脱靶位点**（3' 尾允许 `mispriming_max_mismatches` 个错配，
  默认 1）与**其他模板上的完全匹配**（多重交叉反应；模板序列相同的多个 target 视为**同一个
  模板**，否则每条引物都会"交叉"到自己的扩增子）。
- 大小分辨：差 < 20 bp（`min_size_separation_bp`）= 胶上不可分辨，< 40 bp = 偏近。
- `compatible` 为 `false` 只由三类阻断项决定：**跨 target 二聚体 / 跨模板退火 / 不可分辨的
  扩增子大小**。

### 甲基化与双酶切（v17）

- 判定 `blocked`/`impaired` 的依据是**该酶的识别位点是否真的压在甲基化位点上**（不是序列里
  有没有 GATC）。
- 默认检查对象是"甲基化表覆盖 **且** 消化酶表里确实存在"的 21 个酶；传 `["common"]` 查全表。
- **两张表（甲基化敏感性、buffer 兼容）是手工转录的速查数据**，每个结果都会带回一条 `notes`
  要求对照厂商当前表格复核——表会变，不要把结论当权威。
- buffer 推荐只给**现行** NEB 系列（r1.1/r2.1/r3.1/CutSmart）；`sequential_required: true`
  表示表内无共用 buffer，应顺序酶切或换用厂商双酶切 buffer。
- 双酶切还会点名两种易错情形：某酶在本模板**无位点**、两酶切在**同一磷酸二酯键**（共享切点）。

### 克隆模拟约定

- 酶切-连接要求"插入片段按 5'→3' 书写、上游酶在 5' 端"；单酶连接会给出**双向连接说明**与两种
  方向的验证酶切。
- 特征坐标按插入/缺失**自动平移**；跨越连接点的特征标注 `spans_insertion`。
- Golden Gate 按标准 BsaI 类几何建模（识别位点 + filler + 4 bp 突出端）：连接处不留识别位点，
  载体盒子的位点保留在骨架上（标准 destination 载体行为），`fragments_to_order` 给出可直接下单的
  片段序列；突出端唯一、非回文、非互补，并回溯验证连接处不重建酶位点。
- **不要自己手算特征坐标**：`clone_simulate`/`golden_gate` 的输出里已经带好了，直接喂给画图工具。

### 测序验证与统计

- **Sanger 验证**：参考序列按**环状**处理（读段跨 origin 也能正确对齐）；`.ab1` 中低质量
  （<20）位点单独标注且不计入 `differences_found` 判定；氨基酸后果按 frame 1 假设报告。
- **qPCR**：ΔΔCt 法；标准曲线的效率 E = 10^(−1/slope) − 1（100% 效率对应斜率 −3.32）。
- **虚拟凝胶**：用 log₁₀ 迁移率模型画**预期**条带，是"预期图"而非真实胶的模拟。

### 比对、保守性与标识图

- **MSA** 是启发式渐进比对：仿射缺口（开 −6/延伸 −2，match +4/mismatch −4）、**末端缺口免费**
  （半全局），合并顺序由 5-mer 距离的 UPGMA 树决定。输入上限 2–50 条、单条 ≤ 3000 bp、
  总长 ≤ 30000 bp；输出顺序与输入一致。
- **保守性**：列 identity = 最高频残基数/该列残基数（缺口不计入）；熵基保守性 = 1 − H/2；
  共识 = 最高频碱基（占比 ≥ 50%）否则给出 IUPAC 简并码；全缺口列共识为 `-` 且计为保守。
  `threshold`（默认 0.8）以下为可变位点（至多报告 200 个）。
- **序列标识图**：字母高度 = 信息量 Rᵢ = log₂4 − (Hᵢ + e_n)，**纵轴是 bits（0–2）**，不是"归一化
  到最保守列"；小样本校正 `e_n` 默认开启——这就是"只有 2 条完全相同的序列"时图看起来不高的
  原因（每列 0.918 bits 而非名义上的 2 bits）。`score_type: "frequency"` 可切换成纯频率图。

### CRISPR

- 几何按 SpCas9 约定：protospacer 是紧邻 PAM **5' 侧**的 20 nt；`start`/`end` 是**顶链 1-based
  闭区间**，`sequence` 始终是按 5'→3' 下单的序列，`pam` 始终读在 **guide 靶向的那条链**上。
- 评分逐项公开（GC 偏差、Tm 偏差、poly-T 与同聚、自互补、种子自互补、发夹 Tm、**每个脱靶
  8 分**、PAM 前一位为 G 时 +4），起点 100。**这是排序用的启发式，不是切割效率或特异性的
  预测值。**
- 脱靶搜索只建模**替换**（无 bulge/indel）、要求 PAM 完好、种子末端 2 位不允许错配；默认只搜
  得分最高的若干候选。想在基因组尺度搜索，需要把基因组序列作为 target 传入（当前实现的规模
  上限就是单次调用的序列长度）。

### 文献与记录

- 检索与摘要走 harness 的 **web** 服务（部署不提供时工具会明确报错，而不是假装搜到）。
- 阅读库/协议库/实验日志是工作区里的 `papers.json` / `protocols.json` / `experiments.json`，
  写入遵循会话的**沙箱政策**，与其它文件工具同权；面板（Papers tab）直接读 `papers.json`。
- `molbio_paper_export_bibtex` 可选按 tag 过滤导出。

### 实验台分析（v19）：五件套各自的口径

- **FASTQ 质控**：每碱基统计按**该位置实际有读覆盖的读**计算，`observations` 逐位置给出——曲线
  变细不等于质量下降。四分位用线性插值。**重复率按完整序列精确计数**（FastQC 用 50 bp 前缀哈希
  抽样，本工具不同，`duplication.basis` 写明），且 `estimate_only: true`：扩增子与低起始量文库
  本来就有高重复，重复率高**不等于**测序差。**过度代表序列**的门槛是
  `max(20 reads, 0.1% × 样本)`，所以小样本**合法地什么都不报**（工具不会为了有输出而编一个命中）。
  接头扫描用的是**内置公开短片段表**（TruSeq/Nextera/Illumina/polyA/polyG），不下载任何库。
- **密码子使用**：CAI 用 Sharp & Li 1987，`w = f(密码子)/f(同义最优)`，几何均值**只统计序列里
  真正出现的密码子**，跳过 Met/Trp（单密码子家族 w≡1）与终止密码子；频率为 0 的密码子按国际惯例
  取 `w = 0.5/f_max`，并在 `zero_frequency_codons` 里点名。RSCU 与 Nc 用 Wright 1990 的
  GC3 分箱期望值。**参考频率表是公开数据的转录常量**（E. coli K-12 / S. cerevisiae / H. sapiens），
  测试会断言三张表各自 61 个有义密码子齐全、每个氨基酸家族和为 1，并断言 `molbio_codon_optimize`
  的首选密码子在该宿主里**不是**罕见密码子（两张表不许悄悄打架）。CAI/Nc 是**估算值**，不是表达量。
- **系统发生树**：这是**距离法**（UPGMA / 邻接法），**不是最大似然或贝叶斯**；输出里第一条 `note`
  就写着这句。校正距离在饱和时（Jukes-Cantor 的 p ≥ 0.75、K2P/TN93 参数非正）**没有解**，工具
  把该对记进 `saturated_pairs` 并**夹到模型上限**，而不是返回一个巨大的假数值或直接报错。
  **bootstrap 百分比是列重采样的支持度，不是 p 值**；`seed` 显式给出，同种子必然复现（测试断言
  两次运行的 Newick 与支持度完全一致）。距离按**逐对完整删除**处理（该对里任一位是缺口/简并就跳过，
  `compared` 报实际位点数）。根节点的支持度不外显——那是生根位置造成的，不是可检验的演化支。
- **in-silico PCR**：`max_mismatches`（容许多少错配）与 `three_prime_exact`（3' 端必须精确匹配
  几个碱基，默认 3）是**两个独立旋钮**——中段错配仍能延伸，3' 错配通常不能，所以默认被拒。位点坐标
  一律报在**顶链 1-based**；反向引物的位点其反向互补读在顶链上，产物就是顶链上 `forward.start →
  reverse.end` 那一段。环状模板跨 origin 的产物用取模切片，`wraps_origin: true` 点名。
  `off_target_count` 统计的是**带错配的产物**，不是"扩到了别的模板"。
- **GC 组成与 CpG 岛**：两套阈值都在，因为它们的用途不同——**Gardiner-Garden & Frommer 1987**
  （≥200 bp、GC > 50%、obs/exp > 0.6）会找出很多短岛，**Takai & Jones 2002**（≥500 bp、GC > 55%、
  obs/exp > 0.65）找出更少更长的岛；结果里写明用的是哪套。三个条件是**与**关系：GC 高但 CpG
  obs/exp 低**不算岛**（测试专门钉住这一点）。**累积 GC skew 的极小/极大是复制起点/终点的经典
  *指示*，不是判定**，且只对闭合复制子有意义——序列太短时工具**不给**这个提示并说明原因。
  简并碱基被排除在 skew/CpG/词频统计之外并计入 `n_percent`。

### 明确不做的事（以及为什么）

这些是这个工具集的**边界**，写在这里是为了不再重复勘察：**BAM/CRAM**（二进制格式）、
**reads 比对与基因组级变异检出**（需要索引与外部程序）、**de novo 组装**（算力规模）、
**BLAST 类同源检索**（需要网络与数据库）、**HMM/深度学习预测器**（模型权重）、
**最大似然/贝叶斯建树**（算法规模——本包提供距离法树）、**Kraken/QIIME 类分类**与
**群体遗传学参考面板**（参考数据库）、**基因组尺度 CRISPR 脱靶**（需要全基因组索引）。
每一类在本工具集里都有一个**诚实的本地替代**：用户自带序列的 Smith-Waterman、用户自带的比对、
距离法树、内置小表 + 用户提供的矩阵。更完整的清单与逐条 blocker 见
[docs/capability-gap-survey.md](docs/capability-gap-survey.md) 第 3 节。

---

## 常见问题

**装完选择器里没有 "Molecular Biology Lab"？**
先确认第 2 步（`preset/install.mjs`）跑过并重启了 profile。用 `node <包目录>\preset\install.mjs
--profile web --check` 可当体检；`--dump-config` 里应能看到新增的 preset 扫描根。

**工具在别的会话里消失了？**
这正是 preset 渠道的目的：工具只在 **Molecular Biology Lab** 模式里出现。混合用途 profile 请
一直用 preset 渠道，不要用 bundle 全局安装。

**升级后还是旧行为？**
`dsh plugin --profile <p> update dsh-molbio-tools` 之后要**重启 profile**。若用的是"复制 preset
目录"渠道，必须把新版本的 `vN` 目录复制过去并更新插件行——原地覆盖同一目录**不会**生效（模块按
文件 URL 缓存）。

**没弹出图片窗口？**
看结果里的 `auto_viewed`：`false` 通常意味着无桌面环境（headless）、被 `MOLBIO_AUTO_VIEW=0`
关掉、或本次调用传了 `auto_view: false`。文件本身总是写好了，路径在 `svg_path`/`plot_path` 里。

**传了 `attach_image: true`，但结果里只有 `image_note`？**
那一行就是原因：最常见是**当前模型不声明图像输入**（纯文本路由），其次是当前组合没挂附件服务。
换成支持看图的模型即可；工具与 SVG 都不受影响。另外注意 **PNG 里的文字由内置折线字体绘制，
只覆盖 ASCII 与 `· ° ± — – … ≈ μ α ─`**——中文标题不会出现在 PNG 里（SVG 里照旧）。

**引物/探针一个候选都没有？**
工具会返回 `notes` 说明放宽哪个约束（Tm 窗口、GC 窗口、扩增子长度、探针长度…）。通常是把
`amplicon_min/max` 或 `tm_min/max` 放宽一点即可。

**"帮我把这段序列分析一下" 它却问我要参数？**
把目标说具体即可：要引物还是探针、产物多长、Tm 多少、哪个区域。工具默认值都是常规实验条件
（例如引物 18–28 nt / Tm 55–65 °C / GC 40–60%），不特别说明时按默认来。

---

## 开发者入口

改代码、加工具、发版本、排查组合问题请看 **[docs/maintainer.md](docs/maintainer.md)**，其中包含
与官方插件规范的逐项对照、开发与测试（`npm test`）、发布前预检、preset 组合维护（DSH 升级后
必做）、以及**版本目录规则**的原理与纪律。

其它文档：

| 文档 | 内容 |
| --- | --- |
| [docs/maintainer.md](docs/maintainer.md) | 维护者文档：合规对照、开发测试、发布流程、路线图 |
| [docs/client-panel.md](docs/client-panel.md) | 浏览器内面板：产物格式、服务契约、上限、验证方式、已知限制 |
| [docs/route-b.md](docs/route-b.md) | 安装渠道 B（注册包内 preset）：机制、升级 Runbook、取舍 |
| [docs/client-pipeline-exploration.md](docs/client-pipeline-exploration.md) | 浏览器内面板的可行性与实现路径调研 |
| [docs/capability-gap-survey.md](docs/capability-gap-survey.md) | 能力缺口调查：40 条排序候选、必做 top-5、以及"想做但不可行"的确切阻断原因 |
| [CHANGELOG.md](CHANGELOG.md) | 变更日志（包版本 ↔ preset 版本目录对照） |

包内目录结构：

```
dsh-molbio-tools/
├── index.mjs        # 插件入口：export { name, inject, apply }，注册 57 个工具
├── lib.mjs          # 基础库：IUPAC、翻译、酶表、NN 热力学、qPCR、lab math、甲基化/buffer 参考表
├── design.mjs       # 引物自动设计（含跨内含子 qPCR）
├── taqman.mjs       # TaqMan 水解探针设计（复用 design.mjs 的引物引擎）
├── multiplex.mjs    # 多重 PCR 互扰检查
├── methylation.mjs  # 甲基化敏感位点检查 + 双酶切 buffer 兼容
├── protein.mjs      # 蛋白性质 / 肽段酶切 / 密码子优化
├── protein-structure.mjs # 螺旋轮与疏水性图
├── genbank.mjs      # GenBank flatfile 解析器
├── snapgene.mjs     # SnapGene .dna 二进制解析器
├── plasmid.mjs      # SVG 质粒图谱渲染器
├── align.mjs        # Smith-Waterman 局部比对
├── msa.mjs          # 多序列渐进式比对与保守性分析
├── logo.mjs         # 序列标识图（信息量 + SVG）
├── crispr.mjs       # CRISPR gRNA 设计（PAM 扫描、评分、脱靶搜索）
├── cloning.mjs      # 克隆模拟：选酶/酶切连接/Gibson/Golden Gate/克隆引物/突变引物
├── sanger.mjs       # ABIF (.ab1) 解析 + 测序验证
├── plot.mjs         # SVG 柱状/散点图 + 虚拟琼脂糖凝胶
├── seqio.mjs        # FASTA/FASTQ 解析与统计
├── records.mjs      # 协议库 / 实验日志存储
├── papers.mjs       # 文献库存储
├── view.mjs         # auto-view：把 SVG 交给系统默认应用打开
├── svgpng.mjs       # SVG→PNG 光栅化器（内置折线字体 + 自写 PNG 编码；仅宿主侧用）
├── build/           # 浏览器半源码与零依赖打包器（client-bundle.mjs 是 CLI，client-bundle-core.mjs 是生成逻辑）
├── lib/client.js    # 客户端产物（exports["./client"]，由 npm run build:client 生成）
├── packages/molbio-panel/ # 面板专用包（只面板、不带工具）
├── preset/molbio-lab/     # 推荐安装渠道：专属模式 preset（vN 版本目录）
├── test/            # 冒烟测试 + 光栅化器 + 客户端/组合检查（含 preset 漂移守卫 drift-probe.mjs）
├── docs/            # 维护者与实现文档
└── cordis.patch.yml # bundle 渠道补丁层
```

---

## 许可

MIT（见 [LICENSE](LICENSE)）。
