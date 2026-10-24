# dsh-molbio-tools

**给 AI 助手装上分子生物学的"手"**：一个零依赖的 DeepSeek Harness 插件包，为它提供 **60 个
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
- [它会做什么](#它会做什么)（按任务分组的 60 个工具）
- [典型用法示例](#典型用法示例)
- [输出文件、自动打开与浏览器面板](#输出文件自动打开与浏览器面板)
- [方法学与使用须知](#方法学与使用须知)（各工具的模型、估算范围与边界）
- [常见问题](#常见问题)
- [开发者入口](#开发者入口)

---

## 安装

需要一台已装好 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) 的机器。

### 推荐：在 DSH 插件页安装（3 步）

装完后，预设选择器里会出现 **Molecular Biology Lab** 模式；**60 个工具只在这个模式里出现**，
不会污染你其它会话（这点很重要：工具多了会占提示预算）。**右栏的 Molbio / Papers 两个面板也随这个包
一起装好**，不需要再装 `dsh-molbio-panel`。

1. 打开 DSH Web GUI，点侧栏的 **插件**（Plugins）。
2. 点 **添加插件**（Add plugin），在「包名或地址」里输入 `dsh-molbio-tools`，点 **安装**（Install）；
   装完点 **立即启用**（Enable now）——关掉对话框只会装好、不会启用，之后也可以在插件页打开它的开关。
3. 重启该 profile，然后在预设选择器里选 "Molecular Biology Lab" 新建会话。

### 次选：命令行安装

没有图形界面时（例如服务器上只用 CLI），用这条命令；它和插件页安装等价，都从 npm registry 取包：

```bash
# web 是默认 profile 名，按需替换；装完同样要重启该 profile
dsh plugin --profile web add dsh-molbio-tools
```

> 只有在改本仓库源码、还没发布到 npm 时，才需要从本地目录安装
> （路径按实际情况替换，Windows 示例）：
> ```powershell
> dsh plugin --profile web add D:\path\to\dsh-molbio-tools
> ```

**升级**（图形界面装的也适用）同样只有一条命令，不用重新复制、也不用改配置：

```bash
dsh plugin --profile web update dsh-molbio-tools
```

> **0.7.1 起不再需要"注册 preset 根目录"这一步。**
> DSH 0.1.7-alpha.1 移除了 `@deepseek-ai/dsh-agent-presets` 及其目录发现机制：preset 现在是
> bundle patch 里的一个 `@deepseek-ai/dsh-agent-preset` **行**（本包的是
> `cordis.patch.yml` 里的第二个 insert，由 `dsh.bundle.patch` 声明）。
> 因此 preset 随 bundle 一起安装，**装完即出现**。
>
> 老版本遗留的两样东西可以清理（`node preset\install.mjs --profile web` 会替你查出来）：
>
> - profile 的 `cordis.patch.yml` 里那条 `- id: agent-presets`（目标行已不存在，每次组合会
>   打印 `patch: entry "agent-presets" not found`）；
> - `~/.dsh/.agent-presets/molbio-lab/`（旧机制的死副本，**已不再被读取**，会永远停在旧版本）。

### 备选：复制 preset 目录 —— 0.7.1 起已失效

旧版可把 `preset/molbio-lab/` 复制到 `~/.dsh/.agent-presets/molbio-lab/`。DSH 0.1.7-alpha.1
**不再扫描任何预设目录**，所以这条路已经走不通；请改用上面的 bundle 安装。

### 工具只在专属模式里出现（设计如此）

本包的 bundle patch 是**一个文件、两层 insert**，分工是固定的：

| 层（同一个 `cordis.patch.yml` 里的两段） | 作用 |
| --- | --- |
| `molbio-client` → `./host.mjs` | 只插一行**惰性宿主锚点**，不注册任何工具 |
| `preset-molbio-lab` → `@deepseek-ai/dsh-agent-preset` | 声明 **Molecular Biology Lab** 模式，60 个工具在这一层里 |

所以 60 个工具**只在选中该模式的会话里加载**，其它模式（standard / ptc / minimal / cordis）
不带它们，不占提示预算。bundle 安装 ≠ 工具全局可见：bundle 只是把"模式"和"面板"一起装进来。

> **那一行锚点不是多余的。** DSH 的客户端模块扫描只走**宿主 Loader 树**（官方原话：
> "scans the host Loader's entries"），而 preset 的行在隔离的子树里、扫描永远看不到。所以一个
> 只在 preset 里被引用的 `dsh.client` 包会**失去唯一可被发现的宿主行**，它的浏览器半永远进不了
> `window.__DSH_BOOT__`，右栏那两个 tab 会**静默消失**。`host.mjs` 就是为此存在的惰性锚点
> （它不注册工具、不发布服务），这样既没有工具全局泄漏，面板又能被发现。
> `test/client-mount.mjs` 现在会检查"每个声明了浏览器半、且被 profile 选中的包，必须有一个
> 宿主行能解析到它"，缺了就 FAIL。

> 如果你确实想要"工具对所有会话全局可见"，那需要把工具行加到宿主层——但那不是本包的设计，
> 且会让专属模式里的同一行变成死行（0.1.7 上表现为选择器显示"加载失败"）。

### 只要浏览器面板

如果只想要图形面板、不想让该 profile 装 60 个工具（连模式都不装），装面板专用包即可
（见[浏览器面板](#浏览器面板可选)）。**它和 `dsh-molbio-tools` 二选一**：两者注册同一组右栏 tab
（`dsh-molbio-tools` / `dsh-molbio-tools/papers`），同时装会重复注册并报
`tab type id ... is already registered`。同样在 **插件 → 添加插件** 里输入 `dsh-molbio-panel`，
**安装** → **立即启用**。命令行等价于：

```bash
dsh plugin --profile <profile> add dsh-molbio-panel
```

> 从本地源码目录安装时，把包名换成 `<包目录>/packages/molbio-panel`。

---

## 它会做什么

60 个工具按任务分为十组。下表是"你想做什么 → 用哪个工具"的索引，参数细节模型会在调用时自己
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
| `molbio_design_taqman` | **TaqMan（水解探针）测定设计**：引物对 + 探针一次给出（探针 5' 端非 G、Tm 比引物高 5 °C 起、无 run/重复、不与引物二聚化），每条候选附逐项罚分；支持 **MGB 化学**（更短、按未修饰 NN Tm 报告并明确标注修饰未建模）和**订购 CSV**（引物/探针、5'/3' 修饰、规模、纯化） |
| `molbio_primer_tm` | 单条引物 Tm 估算（Na⁺/Mg²⁺/dNTP 盐校正） |
| `molbio_primer_check` | 引物结构筛查：重复序列、3' 端加权的自互补、发夹、引物对二聚体，以及 Primer3 同款热力学指标 |
| `molbio_multiplex_check` | **多重 PCR 互扰检查**：面板内所有引物对的二聚体、3' 尾的脱靶与跨模板退火、扩增子是否能在胶上分辨，并给出重设计建议；另给出**退火温度建议**（最低引物 Tm − offset，含范围与 Tm 离散警告）和**引物浓度起始计划**（按扩增子大小比例配平） |

### 3. 质粒与图谱（4）

| 工具 | 用途 |
| --- | --- |
| `molbio_parse_snapgene` | 解析 **SnapGene `.dna`**（图谱名称、拓扑、注释特征、序列、描述、accession、已保存引物） |
| `molbio_parse_genbank` | 解析 GenBank flatfile（complement/join 定位、`/gene`、`/product` 等） |
| `molbio_plasmid_map_file` | **一步成图**：直接读 `.dna`/`.gb`/`.gbk` → 把 SVG 图谱**写入工作区**并自动打开 |
| `molbio_plasmid_map` | 从序列 + 特征数组渲染环形/线形图谱（可选 GC skew 环、单切酶标记） |

### 4. 克隆构建（7）

| 工具 | 用途 |
| --- | --- |
| `molbio_unique_cutters` | 克隆选酶：载体单切 + 插入零切的"理想酶"列表（可限定 MCS），也列区间双切酶 |
| `molbio_clone_simulate` | **酶切-连接**（1–2 酶，自动纠正反向插入）与 **Gibson 组装**模拟：最终质粒序列、特征坐标平移、连接点、验证酶切，可直接存 FASTA 与图谱 |
| `molbio_golden_gate` | **Golden Gate 多片段组装**：自动设计 4 bp 突出端、检查酶不切片段、给出可直接下单的片段序列、拼出最终质粒 |
| `molbio_clone_primers` | 给插入片段加酶切位点 + 保护碱基（内置推荐表）或 Gibson 同源臂，并复检全长 Tm/GC/二聚体 |
| `molbio_mutagenesis_primers` | QuickChange 式定点突变引物（`A123G`/`123A>G`/`123_125del`/`after123insGCT`），报告氨基酸变化 |
| `molbio_silent_site_mutagenesis` | **静默酶切位点突变**：在同义密码子范围内添加/移除限制性位点，保持蛋白序列不变；输出逐碱基变化、可直接喂给 `molbio_mutagenesis_primers` 的 mutation texts、突变后序列；只支持识别序列无简并碱基的酶 |
| `molbio_extract_region` | 从质粒文件按特征名（如 "AmpR"、"MCS"）或坐标提取子序列，可选反向互补与存 FASTA |

### 5. 测序与实验数据（6）

| 工具 | 用途 |
| --- | --- |
| `molbio_verify_sanger` | 读 `.ab1`（含碱基质量值）或 `.seq`/`.txt`/`.fasta` → 与参考质粒比对（**环状感知**）→ 错配/缺失/插入报告（含质量标注）、同一性、CDS 内氨基酸后果 |
| `molbio_qpcr_analysis` | ΔΔCt 法：均值/SD、ΔCt、ΔΔCt、fold change（可设扩增效率） |
| `molbio_qpcr_efficiency` | 稀释系列 → 标准曲线：斜率/截距/R²、效率 E = 10^(−1/slope) − 1，可出带拟合线的 SVG |
| `molbio_lab_math` | 稀释计算、摩尔浓度、DNA 拷贝数 |
| `molbio_plot` | **实验数据图表（8 种）**：柱状图（均值±SD 误差棒）、散点图（可选拟合线）、折线图（按分组列拆多条序列）、直方图（分箱默认 Freedman-Diaconis）、箱型图（Q1–Q3 箱 + 中位线 + 1.5×IQR 须 + 离群点）、**小提琴图**（高斯核密度轮廓 + 内部箱；看分布形状时用它）、**火山图**（log2FC × 显著性，带虚线阈值；**只画不检验**，p 值必须由表提供）、**热力图**（行×列矩阵，一格一色 + 色标；支持宽表与长表两种版式，`scale: row_zscore\|log2` 是**显式申报的展示变换**）。表类图表直接读工作区 **CSV/TSV**（`data_path` + `columns` 指名列），也可用 `data` 内联表格文本；结果里带回算好的统计量，**报数请引用它而不是照图估读** |
| `molbio_virtual_gel` | **虚拟琼脂糖凝胶**：给出预期片段大小 → SVG 凝胶图 + 分子量 ladder，和真胶对照 |

### 6. 蛋白质（5）

| 工具 | 用途 |
| --- | --- |
| `molbio_protein_props` | MW、等电点、A280 消光系数、A280(0.1%)、GRAVY、脂肪族指数 |
| `molbio_peptide_digest` | 质谱用酶切模拟：trypsin/chymotrypsin/LysC/GluC（P 前不切）、漏切 0–3、[M+H]⁺ 质量 |
| `molbio_codon_optimize` | E. coli/酵母/人密码子优化，可顺便避开指定酶切位点 |
| `molbio_helical_wheel` | **螺旋轮投影**：残基按 3.6 残基/圈落在圆周上、按性质着色，给出疏水矩 μH（判断是否两亲性），出 SVG |
| `molbio_hydropathy_plot` | **Kyte-Doolittle 疏水性图**：滑动窗口曲线 + GRAVY + 达到跨膜阈值的峰，出 SVG |

### 7. 比对与保守性（7）

| 工具 | 用途 |
| --- | --- |
| `molbio_align` | Smith-Waterman 局部比对：可读的比对线、同一性%、比对区间、错配/缺失/插入列表 |
| `molbio_msa_align` | **多序列比对**（2–50 条 IUPAC DNA）：渐进式比对，返回比对结果与两两同一性 |
| `molbio_conservation` | **保守性分析**：共识序列、逐列 identity、熵基保守性打分、保守/可变位点统计 |
| `molbio_alignment_postprocess` | **比对后处理**：共识（plurality/union/strict 三选一）、按缺口比例修剪（报原始 1-based 列号）、两两同一性矩阵、逐列覆盖度 |
| `molbio_sequence_logo` | **序列标识图**：把保守性画成 SVG logo（字母高度 = 信息量 bits） |
| `molbio_fasta_fastq` | 工作区 FASTA/FASTQ：条目统计、按 id 提取、FASTQ→FASTA、FASTQ 质量报告 |
| `molbio_batch_analyze` | **批量文件分析 + CSV/TSV**：对目录（或显式 paths）里所有匹配的 FASTA/FASTQ/GenBank/.dna 跑同一套摘要/ORF/酶切位点分析；单个坏文件是一行 error，不会中断整批 |

### 8. CRISPR（1）

| 工具 | 用途 |
| --- | --- |
| `molbio_grna_design` | **gRNA 设计**（默认 SpCas9 `NGG` PAM，亦可 SaCas9/Cas12a/Cas13a/Cas13b/Cas13d）：按家族选择 PAM/PFS 侧、crRNA 长度和种子定义（Cas12a 是 5' TTTV + 5' 种子，Cas13 是 RNA 靶标 + PFS 偏好而非 PAM）；双链扫描、GC/poly-T/自互补/发夹等质量指标、逐项公开的启发式评分，以及**同序列内的错配容差脱靶搜索**；可出订购 CSV 与带标记的图谱 |

### 9. 文献与实验记录（12）

| 工具 | 用途 |
| --- | --- |
| `molbio_pubmed_search` | 通过 harness 的 web 检索服务搜文献，自动提取 PMID |
| `molbio_pubmed_abstract` | 按 PMID 拉取摘要（依赖部署提供 web fetch 能力） |
| `molbio_paper_add` / `molbio_paper_list` / `molbio_paper_update` / `molbio_paper_remove` | 阅读库（工作区 `papers.json`）：加/列/改/删，按 PMID→URL→标题+年份去重 |
| `molbio_paper_export_bibtex` | `papers.json` → BibTeX `.bib`（可按 tag 过滤） |
| `molbio_protocol_add` / `molbio_protocol_list` / `molbio_protocol_update` | 协议库（`protocols.json`）：步骤列表、自由参数、来源文献 |
| `molbio_experiment_log` / `molbio_experiment_list` | 实验日志（`experiments.json`）：关联协议与文献、笔记与结果 |

### 10. 实验台分析（5，v19 新增，树图 v20 改进）

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
| "把这 60 个质粒/reads 一起做个汇总表" | `molbio_batch_analyze(directory, pattern, analysis:'all', enzymes:[…])` → 一张 CSV/TSV |
| "把 EcoRI 位点静默去掉，蛋白不能变" | `molbio_silent_site_mutagenesis(sequence, enzyme:'EcoRI', action:'remove')` → mutation texts → `molbio_mutagenesis_primers` |
| "用 Cas12a 设计 gRNA（5' TTTV PAM）" | `molbio_grna_design(sequence, cas_family:'cas12a')` |
| "用 Cas13a 敲低这个转录本" | `molbio_grna_design(sequence, cas_family:'cas13a', target_strand:'forward')` → 看 PFS 与 require_pfs |
| "TaqMan 用 MGB 探针，并出一张订购表" | `molbio_design_taqman(sequence, probe_chemistry:'mgb', save_path:'order.csv')` |
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
| `molbio_qpcr_efficiency` / `molbio_plot` / `molbio_virtual_gel` | 曲线；`molbio_plot` 的柱状/散点/折线/直方图/箱型/小提琴/火山/热力图（`output_path` 必填）；凝胶图 |
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

**字体（SVG 与 PNG 不同，这一点要知道）**：SVG 里**在根 `<svg>` 上声明一次**
`'Times New Roman', 'Liberation Serif', 'Nimbus Roman', Times, serif`（`svgio.mjs` 的
`FIGURE_FONT`），所有 `<text>` 继承它——衬线、符合学术排版习惯，且后两个是 **Times 同度量**的
替代字体，所以在 Linux/macOS 上换字体**不会让图形重排**。（`textRun`/`textSpanLines` 保留了
`family` 参数作为逐次覆盖的逃生口，默认不再输出该属性。）而 **PNG 光栅化器完全忽略
`font-family`**：它用内置折线字体绘制，不看系统字体。因此

- 投稿、插进 Word/LaTeX、在 Illustrator 里改字的，用 **SVG**，字体是 Times New Roman；
- 模型通过 `attach_image` 看到的那张 **PNG**，字形是内置的、无衬线单线体（这是"零依赖、
  无字体文件"的必然代价）。想两者一致，得把 PNG 交给你自己的转换器重做。

**产物的两条守卫（`test/contract.mjs`）**：一条断言**提交的产物 == 当前源码构建出来的产物**
（拦住"改了源码忘记重跑 `npm run build:client`"）；另一条断言**产物里真的含有打包器声明的
每一个模块**（拦住上一条看不见的情况——产物是**更早**的模块图构建的，某个模块从来没进去过，
而这种缺失在上一条里两边都少、比较结果一样）。第二条是本仓库真实踩过的：`lib/client.js` 与
面板产物曾长期缺少 `svgio.mjs` 和 `font-metrics.mjs`。

**"光栅化器不进浏览器半"那条守卫是结构性的**：它把产物自己的模块注册表读回来，问"光栅化器
在不在这个集合里"，**不做文本搜索**——所以注释里怎么写都不会误报（此前正是注释触发了它，
详见 [docs/roadmap.md](docs/roadmap.md) 3.5）。打包器另有一道**构建期自检**：产物注册的模块
必须等于本次模块图走到的集合。

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
- **MGB（0.20.0）**：`probe_chemistry: "mgb"` 用 13–20 nt、未修饰 NN Tm 48–60 °C 的窗口。
  MGB 修饰会把真实 Tm 抬高，但**NN 模型不预测这个增量**，所以报告的是未修饰 Tm，并在
  `tm_model`/notes 里要求向供应商复核；也不会用"探针 Tm 必须高于引物"的未修饰差值去惩罚每个
  MGB 候选。
- **订购 CSV（0.20.0）**：`save_path` 写出每条 assay 的 F/R/P 三行，含 5'/3' 修饰、合成规模与
  纯化；不传路径时只返回结构化 `order`。探针默认 5' FAM、3' 按化学（MGB 默认 NFQ-MGB）。

### 多重 PCR 互扰（v17）

- 面板内**所有**引物对都算二聚体；同一 target 内正向+反向是设计时已校验的预期配对，不冲突时
  不报告（冲突时照样报）。
- 非预期退火分两类：**自身模板的脱靶位点**（3' 尾允许 `mispriming_max_mismatches` 个错配，
  默认 1）与**其他模板上的完全匹配**（多重交叉反应；模板序列相同的多个 target 视为**同一个
  模板**，否则每条引物都会"交叉"到自己的扩增子）。
- 大小分辨：差 < 20 bp（`min_size_separation_bp`）= 胶上不可分辨，< 40 bp = 偏近。
- `compatible` 为 `false` 只由三类阻断项决定：**跨 target 二聚体 / 跨模板退火 / 不可分辨的
  扩增子大小**。
- **退火温度（0.20.0）**：`annealing.recommended_c` = 最低引物 Tm − `annealing_offset_c`
  （默认 3 °C），`range_c` 按其 ±window 给范围；`spread_c` 超过阈值时明确说"一个温度不可能对
  所有引物最优"。这是规则性起点，不是热循环优化。
- **引物浓度（0.20.0）**：默认 200 nM；当已知扩增子大小比 ≥ 2 时，最短的降到 150 nM、最长的
  升到 300 nM。`rationale` 逐 target 说明属于哪种情形，notes 写明这是起始点而非实测最优。

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
- **末端缺口免费，但一个残基都不会丢**（v20 修复）：半全局评分允许比对路径在任一序列末尾之前
  停下（这有时就是最高分的选法），此时**路径之外的残基会作为纯悬垂列补进结果**，而不是被丢掉。
  v19 及更早版本会静默截断尾端悬垂——11 bp 对 10 bp 返回 10 列、少一个碱基。现在每条输出行
  去掉缺口后**恰好等于它的输入序列**（测试逐条钉住这条不变式），而 `score` 仍是 DP 最优值
  （悬垂列计 0 分，与被它替换的末端缺口同分）。
- **保守性**：列 identity = 最高频残基数/该列残基数（缺口不计入）；熵基保守性 = 1 − H/2；
  共识 = 最高频碱基（占比 ≥ 50%）否则给出 IUPAC 简并码；全缺口列共识为 `-` 且计为保守。
  `threshold`（默认 0.8）以下为可变位点（至多报告 200 个）。**平票**（两残基并列最多）
  取**字母序靠前**的那个，是确定性约定、不是简并码。
- **比对后处理**（v0.19.0，`molbio_alignment_postprocess`）：
  - **共识有三种口径，由 `consensus_mode` 选，它们是不同的答案**：`plurality`（默认，达
    `consensus_threshold` 给该残基，否则给观察到的碱基的并集码）、`union`（一律并集码）、
    `strict`（达阈值给残基，否则给 `N`——混合位点绝不伪装成一个碱基）。
  - **修剪阈值与覆盖阈值是两件独立的事**。`max_gap_fraction`（默认 0.5）标记"缺口太多、
    建议删"的列，列号是**修剪前的原始 1-based 坐标**；`coverage_threshold`（默认 0.8，
    非缺口比例）标记"数据不全"的列。一列完全可以**既该保留、又值得提示**——本工具的
    输出文本同时给出两者，不要把它们当成一个判据。
  - **同一性矩阵的分母与 `molbio_conservation` 不同，两个数不可互换**：矩阵排除
    **双缺口列**（两行都没有残基的位置不参与统计），而 `pairwiseIdentities` 除以**全部列**。
    同一组序列上均值可能是 37.17% 与 32%，两个都对，口径不同。工具的输出文本里写明了
    用的是哪一个。
  - 序列数超过 50 时**矩阵省略而非截断**（`identity_matrix_included: false`），均值/最小/最大
    仍覆盖每一对；逐列清单上限 500 并带 `*_truncated` 标志。
- **序列标识图**：字母高度 = 信息量 Rᵢ = log₂4 − (Hᵢ + e_n)，**纵轴是 bits（0–2）**，不是"归一化
  到最保守列"；小样本校正 `e_n` 默认开启——这就是"只有 2 条完全相同的序列"时图看起来不高的
  原因（每列 0.918 bits 而非名义上的 2 bits）。`score_type: "frequency"` 可切换成纯频率图。

### CRISPR

- **几何按家族**（0.20.0）：SpCas9 是 3' NGG / 20 nt / 3' 种子；SaCas9 是 3' NNGRRT / 21 nt；
  **Cas12a 是 5' TTTV / 23 nt crRNA / 5' 端种子**；**Cas13a/b/d 是 RNA 靶标 + PFS 偏好**（不是 PAM：
  Cas13a 3' H / 28 nt，Cas13b 5' D + 3' NAN / 30 nt，Cas13d 无 PFS / 22 nt）。`start`/`end` 仍是
  顶链 1-based 闭区间，`sequence` 是按 5'→3' 下单的 DNA 序列（Cas13 另给 `rna_sequence`），
  `pam` 读在 guide 靶向的那条链上（Cas13 为空）。
- **PFS 不是 PAM**：Cas13 的 PFS 缺失只扣分并标注，只有 `require_pfs: true` 才过滤；Cas13 不报
  DNA NN Tm（返回 null），因为 guide 是 RNA。
- **反向链脱靶**（0.20.0 修复）：旧 `finalizeSites` 对反向命中减了 `guideLength-1`，使反向脱靶
  偏移 19 nt 并大多被丢弃；现在两种链都从 top-strand 起点算，PAM 按 5'/3' 侧与链向取窗口。
- 评分逐项公开（GC 偏差、Tm 偏差、poly-T 与同聚、自互补、种子自互补、发夹 Tm、**每个脱靶
  8 分**、PAM 前一位为 G 时 +4），起点 100。**这是排序用的启发式，不是切割效率或特异性的
  预测值。**
- 脱靶搜索只建模**替换**（无 bulge/indel）、要求 PAM 完好、**家族对应的种子端**不允许错配
  （SpCas9/SaCas9 3' 末 2 位，Cas12a 5' 起 2 位，Cas13 无硬种子）；默认只搜得分最高的若干候选。
  想在基因组尺度搜索，需要把基因组序列作为 target 传入（当前实现的规模上限就是单次调用的
  序列长度；Cas13 另有候选窗口上限并提示缩小 region）。

### 批量分析（0.20.0）

- 目录扫描默认不递归；`recursive: true` 才进子目录（深度上限 8）。`paths` 与 `directory` 二选一，
  显式 paths 优先。
- 每个文件独立解析，**坏文件是一行 `error`**，不会让整批失败；`truncated` 表示触到文件数/字节上限。
- 拓扑以 GenBank/SnapGene 声明为准（环状质粒的酶切位点计数不会按线性处理），没有声明时才用
  `circular` 参数。ORF 用所选遗传密码与 ATG 起始规则；长 ORF 不等于真基因。

### 静默位点突变（0.20.0）

- 只在**同义密码子**内枚举：蛋白序列按构造不变；`changes` 逐碱基给出位置/前后碱基/密码子/氨基酸。
- `mutation_texts` 是 `A123G` 形式，可直接传给 `molbio_mutagenesis_primers`；`mutated_sequence`
  是改完的 CDS。
- 只支持识别序列**无简并碱基**的酶（`GGTNACC` 这类直接拒绝）；`host` 只影响同义密码子的排序，
  不改变"是否静默"这一事实。静默是蛋白层面的，mRNA 结构/剪接/密码子使用仍可能变化。

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
  **长叶名会自动折行**（v20 矩形式布局，v0.19.0 环形/扇形）：矩形式布局把叶名折成多行
  `<tspan>`，列宽按内置字体的真实字宽计算，字号只在必要时才缩小——v19 把长名字画成一行、
  直接压到相邻标签上。若你的标签被折行，说明它超出了为该列预留的宽度。
  **环形与扇形的标签沿各自半径旋转**：折行宽度按 `W·|cos θ|` 换算成径向深度，整块绕锚点旋转
  （多行随块一起转，所以行距仍然垂直于半径），并在**旋转后的四个角都落在绘图矩形内**之前
  逐级缩小字号；半径本身由实测的标签深度反推，而不是面板的固定比例。v0.19.0 之前这两种布局
  的标签是整行画出去的，名字比一个**猜出来的**余量长就直接落到画布外——不报错、不提示。
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
先确认该 profile 的 `dsh.profile.bundles` 里有 `dsh-molbio-tools`（**不是**只有
`dsh-molbio-panel`——面板包不带 preset），然后重启 profile。体检命令：

```powershell
node <包目录>\preset\install.mjs --profile web          # 报告 + 真实组合验证
node <包目录>\preset\install.mjs --profile web --check  # 只报告，不组合
```

它会顺带查出老版本遗留的 `agent-presets` 死配置与 `~/.dsh/.agent-presets` 死副本。

**工具在别的会话里消失了？**
这不是故障，是设计：工具只在 **Molecular Biology Lab** 模式里出现，其它模式不带它们。

**选了模式却显示"加载失败"？**
先跑一次体检（上一段。它会核对 preset 里的工具行是否写成**包名**——写成相对路径
`./plugins/…` 时 preset 能挂载但一个工具都加载不了，选择器就显示加载失败）。

**升级后还是旧行为？**
`dsh plugin --profile <p> update dsh-molbio-tools` 之后要**重启 profile**。
（"复制 preset 目录"渠道在 DSH 0.1.7-alpha.1 已失效，见[安装](#安装)一节。）

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

改代码、加工具、发版本、排查组合问题请看 **[docs/maintainer.md](docs/maintainer.md)**（导航页）。
维护者文档按"你要回答的问题"分成四份：

| 文档 | 回答的问题 |
| --- | --- |
| [docs/rules.md](docs/rules.md) | 什么**不能**违反（preset 行必须按包名引用、座位必须 `slots.inject`、产物三条纪律…） |
| [docs/workflow.md](docs/workflow.md) | **怎么做**：测试金字塔各层在防什么、客户端半、发布预检、**CD（推 tag 自动发布）**、DSH 升级后怎么做 |
| [docs/roadmap.md](docs/roadmap.md) | 接下来**往哪走**，以及明确不做的清单 |
| [docs/history.md](docs/history.md) | **已经发生了什么**、每个 bug 换来了哪条规则 |

**发布（CD）**：CI 是 `.github/workflows/test.yml`（push / PR 跑全套，双平台），CD 是
`.github/workflows/release.yml`——**推一个 `v*` tag 就会**在被打 tag 的提交上重跑全套、过
`build/release-preflight.mjs` 的发布前置检查，然后用 npm 的 **Trusted Publishing（OIDC）**
把两个 npm 条目分开发布（仓库里没有任何长期 token），最后用 CHANGELOG 该版本段落建 GitHub Release。
两个包的**首次发布必须由人手动做一次**（可信发布要求包已存在于 npm），步骤见
[docs/workflow.md](docs/workflow.md) 第 4 节。

想评估"模型到底会不会用这些工具"，看 **[benchmark/README.md](benchmark/README.md)**：
`npm run bench:offline` 零成本校验期望值（在 `npm test` 里），`npm run bench` 用真实模型
跑 **core 档 14 题**，`npm run bench:full` 跑**全部 61 题（覆盖 60/60 个工具）**。

> **改动与 benchmark 的关系（硬规则）**：新增或改动任何工具行为，**必须**新增/更新对应的
> benchmark 任务并重跑；没有改动就不必重跑。日常只需要一条命令——
> `node benchmark/run.mjs --model --changed`——它会从你的改动反推出该跑哪几题
> （`lib.mjs` 这类共享库会自动放大到全量），改动只在文档/测试时则直接回答"无事可跑"。
> `test/benchmark-coverage.mjs` 会拦住"新工具没有任务"（断言 60/60 覆盖），
> `bench --offline` 会拦住"期望值过期"。完整对照表见
> [docs/workflow.md](docs/workflow.md) 第 2 节。

> **benchmark 已经查出的一个真实缺陷**：`molbio_design_primers` 返回的引物对把
> forward/reverse **标反了**（`F` 在 201-222、`R` 在 105-124，即 F 在 R 下游），
> 按原样送进 `molbio_pcr_simulate` **不产生产物**。已用工具直接复核，详见
> [benchmark/README.md](benchmark/README.md) 的 Findings。**尚未修复**——
> 它需要自己的回归测试（设计出的一对引物按原样必须能模拟出恰好一个产物）。

其它文档：

| 文档 | 内容 |
| --- | --- |
| [docs/maintainer.md](docs/maintainer.md) | 维护者导航页 + 60 秒速览 + 包内目录结构 |
| [docs/client-panel.md](docs/client-panel.md) | 浏览器内面板：产物格式、服务契约、上限、验证方式、已知限制 |
| [docs/route-b.md](docs/route-b.md) | 安装渠道 B 的历史记录（0.1.7-alpha.1 起该渠道已废弃） |
| [docs/client-pipeline-exploration.md](docs/client-pipeline-exploration.md) | 浏览器内面板的可行性与实现路径调研 |
| [docs/capability-gap-survey.md](docs/capability-gap-survey.md) | 能力缺口调查：40 条排序候选、必做 top-5、以及"想做但不可行"的确切阻断原因 |
| [benchmark/README.md](benchmark/README.md) | 可用性评估：题目集、判分口径、headless profile 的推导与守卫 |
| [CHANGELOG.md](CHANGELOG.md) | 变更日志（包版本 ↔ 历史 preset 版本目录对照） |

包内目录结构：

```
dsh-molbio-tools/
├── index.mjs        # 插件入口：export { name, inject, apply }，注册 60 个工具
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
├── align-post.mjs   # 比对后处理：共识/缺口修剪/同一性矩阵/逐列覆盖度
├── logo.mjs         # 序列标识图（信息量 + SVG）
├── crispr.mjs       # CRISPR gRNA 设计（SpCas9/SaCas9/Cas12a/Cas13 家族几何、评分、脱靶搜索）
├── cloning.mjs      # 克隆模拟：选酶/酶切连接/Gibson/Golden Gate/克隆引物/突变引物
├── silent-site.mjs  # 静默酶切位点突变（同义密码子内添加/移除位点）
├── sanger.mjs       # ABIF (.ab1) 解析 + 测序验证
├── plot.mjs         # SVG 柱状/散点图 + 虚拟琼脂糖凝胶
├── charts.mjs       # 实验数据图表：CSV/TSV 读取 + 折线/直方图/箱型/小提琴/火山/热力图（基于 svgio）
├── seqio.mjs        # FASTA/FASTQ 解析与统计
├── batch.mjs        # 批量文件分析：同一套摘要/ORF/酶切位点 → CSV/TSV
├── records.mjs      # 协议库 / 实验日志存储
├── papers.mjs       # 文献库存储
├── view.mjs         # auto-view：把 SVG 交给系统默认应用打开
├── svgio.mjs        # 共享绘图助手（几何 + 折行；进客户端产物）
├── font-metrics.mjs # 字宽度量（**进客户端产物**：svgio 靠它算折行宽度，面板要画图）
├── svgpng.mjs       # SVG→PNG 光栅化器（内置折线字体 + 自写 PNG 编码；仅宿主侧用）
├── build/           # 浏览器半源码与零依赖打包器（client-bundle.mjs 是 CLI，client-bundle-core.mjs 是生成逻辑）
├── lib/client.js    # 客户端产物（exports["./client"]，由 npm run build:client 生成）
├── packages/molbio-panel/ # 面板专用包（只面板、不带工具）
├── preset/molbio-lab/     # 专属模式 preset：agent.cordis.yml 是行清单（手改这里）
│                          #   preset.yml 是选择器文案；两者由生成器写进下面的 cordis.patch.yml
├── benchmark/       # 可用性评估：tasks/*.json + 判分器 + headless profile 推导（见其 README）
├── test/            # 冒烟 + 光栅化器 + 客户端/组合检查（含 preset 漂移与 benchmark profile 守卫）
├── docs/            # 维护者与实现文档（rules / workflow / roadmap / history 是本目录的骨架）
└── cordis.patch.yml # 唯一 bundle patch（生成物）：锚点 insert + preset insert
```

---

## 许可

MIT（见 [LICENSE](LICENSE)）。
