# v19 实现计划 — "bench 分析"五件套（包 0.11.0 / preset 目录 v19）

> **状态：已实现（2026-09-18）。** 本文是施工时的设计文档，保留原样以便对照"计划 vs 落地"。
> 实际实现与本文的两处偏差记录在文末「实现后的偏差」一节，交付说明见
> [CHANGELOG 0.11.0](../CHANGELOG.md) 与 [maintainer.md 的 v19 段](maintainer.md)。

**方向来源**：`docs/capability-gap-survey.md` §2「必做 top-5」+ §6 的一段式建议。
**工具数**：52 → 57。**新增 6 个模块**（`fastq-qc` / `codon` / `phylo` / `pcr` / `composition` / `svgio`）。
**发版纪律**（不可违反）：插件 `.mjs` 有改动 → 必须新建 `preset/molbio-lab/plugins/dsh-molbio-tools-v19/`，
**绝不原地改 v18 目录**（DSH 的 ESM 缓存按文件 URL 键控）。

---

## 0. 先决修复：`test/contract.mjs` 绑定了格式（DSH 0.1.6-alpha.2 漂移）

本机 harness 已是 `0.1.6-alpha.2`（仓库发布基线是 alpha.1），`npm test` 现挂 1 项：

```
FAIL the sessions root hook is provided by the session client package
     it contributes root hooks
```

**根因**（已实测，非产品 bug）：`test/contract.mjs:137`

```js
assert.ok(session.text.includes('ctx.slots.provideRoot({ hooks: {'), 'it contributes root hooks');
```

写死了**单空格**拼写；alpha.2 的同一个调用改成了换行缩进：

```js
ctx.slots.provideRoot({
    hooks: {
        sessions: ctx.sessions.list,
        sessionStatus: service.sessionStatus
    },
    keyedHooks: { sessionRetainInfo: (key) => ctx.sessions.retainInfo(key) }
});
```

同一 check 里紧跟的第 138 行用**空白容忍正则**（`/provideRoot\(\{\s*hooks:\s*\{\s*sessions:/`）——它是**通过**的，
`installScope("session")` 也通过。契约没动，只是 minifier 的换行形态变了。而该文件开头的注释恰好写明它
"断言**契约**（一条规则、一个调用、一个服务名），**绝不绑定偶然的格式**"。

**修法**：把第 137 行换成正则 `/ctx\.slots\.provideRoot\(\s*\{\s*hooks:\s*\{/`（与第 138 行同风格），
并在注释里记一句"alpha.2 把这条调用改成多行缩进；只断言调用形状"。

**回归守卫**：`test/drift-probe.mjs` 已有的模式是"用变异输入证明守卫会失败"——这里补一条：
把安装包的 `provideRoot` 调用改回单行/改多行两种形态，断言新断言都通过（证明它不再绑格式），
而把 `hooks:` 改名成 `hookz:` 时断言**失败**（证明它仍在检查契约）。

---

## 1. 五个新工具总览

| # | 工具 | 新模块 | 回答的问题 | 复用 |
|---|---|---|---|---|
| 1 | `molbio_fastq_qc` | `fastq-qc.mjs` | "这个测序跑得好不好，质量从哪里开始掉？" | `seqio.parseFastq`、`svgio`、`attach_image` |
| 2 | `molbio_codon_usage` | `codon.mjs` | "这个基因在 E. coli 里表达会好吗，问题密码子是哪些？" | `protein.CODON_USAGE`、`lib.GENETIC_CODES` |
| 3 | `molbio_phylogenetic_tree` | `phylo.mjs` | "这个样品跟谁最近，这个结论有信心吗？" | `msa.progressiveAlign` 抽出的 UPGMA、`svgio` |
| 4 | `molbio_pcr_simulate` | `pcr.mjs` | "这对引物还会在哪里扩增，预期条带多大？" | `lib` 全部引物热力学、`plot.renderGel` |
| 5 | `molbio_gc_composition` | `composition.mjs` | "这里是启动子区吗？复制起点在哪？" | `lib` 组成统计、`svgio` |

每个工具都遵守现有三条纪律：**纯计算/确定性**（画图工具例外地写 SVG 文件，走 `writeSvgFile`）、
**输出 schema 落在 harness enforced subset 内**、**错误走 `MolbioInputError`**；画图工具（1/3/4/5）
额外提供可选 `attach_image`，于是带该参数的工具从 11 个变成 **15 个**。

### 新模块 `svgio.mjs`（无工具，只有渲染助手）

`plasmid.mjs` / `plot.mjs` / `logo.mjs` / `protein-structure.mjs` 各自复制了 `escapeXml`、`round`、
`formatTick`、Y 轴缩放这类碎片。v19 的 4 张新图不该再抄第 5 份。`svgio.mjs` 提供：

- `escapeXml(text)`、`round(value, digits)`、`formatTick(value)`；
- `linearScale(domain, range)` → `{ of(value), ticks(count) }`（含"取整刻度"算法）；
- `svgDocument({ width, height, title, body })` → 带 `viewBox` + 白底 + `<title>` 的完整文档；
- `panel({ x, y, width, height, title, subtitle })` → 多面板布局框（FastQC 报告用）；
- `colorRamp(t)` → 质量→颜色（绿/黄/红三段，FastQC 同款语义）；
- `textRun({ x, y, text, size, anchor, fill, rotate })`。

**关键约束**：`svgio.mjs` 只允许产出 `svgpng.mjs` 已支持的构造（`rect/line/circle/polygon/polyline/path/text`，
无 `<g transform>`、无渐变、无 `url(#…)`），否则 `test/svgpng.mjs` 的"真实产物必须落在支持子集内"会失败——
这正是我们要的：新增画法会在测试里失败，而不是从图里静默消失。
`svgio.mjs` **不进客户端产物**（同 `svgpng.mjs`，只有宿主侧画图用）；`test/svgpng.mjs` 已有的
"光栅化器不得进入客户端产物"守卫扩展成"宿主专用渲染助手不得进入客户端产物"。

---

## 2. `molbio_fastq_qc` — 读级 FASTQ 质控报告

**模块**：`fastq-qc.mjs`。**主入口**：`fastqQcReport(entries, options)`。

**参数**：`path`（工作区 `.fastq/.fq`，或 `fastq` 内联文本二选一）、`max_reads`（默认 0 = 全量，
上限 200000，超出明确报错而不是静默截断）、`duplication_reads`（重复分析取样数，默认 100000）、
`adapter_scan_reads`（默认 10000）、`window`（每碱基内容窗口）、`output_path`、`auto_view`、`attach_image`。

**算法**（全部来自 FastQC 的 12 个模块中**纯文本算术**的那批，逐项在输出里标注口径）：

1. **每碱基质量**：对每个位置取该位置所有读的 Phred+33 值 → 均值、**下/上四分位、10/90 分位、min/max**；
   画成带 IQR 箱的折线（FastQC 的画法：黄箱=25–75%，蓝线=均值，红=中位）。
2. **每序列质量**：每条读的均值 Phred → 直方图（0–40 分箱）+ 均值/中位/最差读 id。
3. **每碱基序列内容**：A/C/G/T/N 各位置的百分比（按窗口取值）。
4. **每序列 GC 分布**：理论分布（由每读长度 + 整体 GC 推的正态曲线）与实测叠画——
   **理论曲线要写明是近似**（FastQC 自己也叫它 "theoretical distribution"）。
5. **每碱基 N 含量**、**长度分布**（min/max/mean/median/N50 风格的中位长度）。
6. **重复序列**：按**精确序列计数**统计（"以 100000 读为上限的部分重复分析"），
   输出 `duplication_percent`、`remaining_percent` 曲线（去重后保留比例），**明确写"仅供估计"**：
   真 FastQC 用 50 bp 前缀哈希抽样，我们按完整序列精确计数（更准但只在取样范围内）。
7. **过度代表的 k-mer（overrepresented sequences）**：统计出现频次显著高于背景的序列/k-mer，
   输出 top 20 + 占比 + 可能的来源（若命中内置接头/载体短表则点名，否则 `unknown`）。
8. **接头含量**：扫描**内置短表**（TruSeq/Nextera/Illumina 通用接头片段 12 bp，公开常量），
   输出每碱基累计接头命中率曲线 + 命中数。**不下载任何库**。
9. **Q20/Q30 比例**、总 reads/bases、`per_base_quality_tail`（从哪一位置起均值跌破 Q30/Q20——实用结论）。

**输出**：结构化数字（模型可直接推理）+ `report_path`（多面板 SVG）。**所有曲线都同时给数字数组**，
不把结论只画在图里。

**错误路径**：非 FASTQ、质量串短于序列（`seqio.parseFastq` 已抛）、`max_reads` 超上限、
空的碱基统计、`output_path` 不可写。

**冒烟测试（手算已知值）**：自建 50 条 4 bp 读的夹具，Phred 值手工排布 → 逐位置均值/四分位、
Q20/Q30 计数、GC 分布、N 计数、重复率（把其中 10 条写成同一条 → 期望 `duplication_percent` 精确值）、
接头命中（夹具里塞一条完整 TruSeq 接头 → 必须命中且 `source` 点名）；错误路径 4 条。

---

## 3. `molbio_codon_usage` — 密码子使用分析（CAI / RSCU / ENC）

**模块**：`codon.mjs`。**主入口**：`codonUsageAnalysis(cds, options)`。

**复用**：`protein.mjs` 已内嵌 `CODON_USAGE`（e_coli/yeast/human 的**高频密码子排序**，不是频率表）。
RSCU 需要的是**每个密码子的使用次数/频率**，因此 `codon.mjs` 自带三套**参考频率表**（公开常量，注明来源口径），
并把 `CODON_USAGE` 的第一选择作为"最优密码子"与频率表交叉校验（**测试断言两表对每个氨基酸的首选密码子一致**——
不一致就说明转录错了，这是本项目一贯的"表要能被测试钉住"做法）。

**指标**：
- **CAI**（Sharp & Li 1987）：`w_i = f(codon) / f(同义最优密码子)`，`CAI = exp(mean(ln w_i))`；
  `f = 0` 时按惯例取 `w = 0.5 / f_max`（**在输出里标注这一约定**）。
- **RSCU**（每密码子）：`RSCU = f_i / (mean f of 同义家族)`；1.0 = 无偏好。
- **ENC / Nc**（Wright 1990）：按 GC3 分箱的期望同义密码子数 → `Nc = 2 + 9/F + 1/F²`，
  输出 **Nc 与 GC3** 及"表达预期"的定性说明（Nc 越低偏好越强）。
- **GC3 / GC123**：三个密码子位置的 GC（Biopython `GC123` 同义）。
- **罕见密码子报告**：该基因里 `w_i < 0.2` 的密码子逐个列出（位置、密码子、氨基酸、宿主频率）。
- **CDS 内的 CpG**：CDS 里 CpG 的实际/期望比（`obs/exp`，低 CpG 影响哺乳动物表达）。
- **隐藏终止子**、内部 `ATG`、非 `ACGT` 字符、长度非 3 倍数、无起始 ATG、无终止密码子 → 逐项**报告为警告**（不抛错，除了非法输入）。

**输出**：`cai`、`cai_by_region`（可选的滑窗 CAI 轮廓，够画图）、`rscu`（全 61 个密码子）、
`n_codon`/`gc3`/`gc123`、`rare_codons`、`cpg_observed_expected`、`warnings[]`、`host`。

**冒烟测试**：手工构造 3 个 CDS：
(i) 全用宿主最优密码子 → `CAI = 1.0` 精确；(ii) 全用最差密码子 → 手算 `w` 与几何均值（钉住到 4 位小数）；
(iii) 单氨基酸家族的手算 RSCU（如 3 个 Leu 用 CTG/CTC/CTT + 参考频率 → 手算值）。
外加 Nc 的已知值（单 GC3 分箱退化情形）、罕见密码子命中、CpG 计数、六条警告路径、错误路径 3 条。

---

## 4. `molbio_phylogenetic_tree` — 距离树 + Newick + SVG

**模块**：`phylo.mjs`。**主入口**：`buildTree(sequences, options)`、`toNewick(tree)`、`parseNewick(text)`、
`renderTreeSvg(tree, options)`。

**复用与抽取**：`msa.mjs` 里已有 `kmerDistances`（5-mer 距离）与 `upgmaGuide`（UPGMA 指导树），
但它们是**私有函数**。v19 把这两个抽成 `phylo.mjs` 的 `kmerDistanceMatrix` / `upgmaTree`，
`msa.mjs` 改为从 `phylo.mjs` import（**逐字节行为不变**——现有 v15 冒烟断言"同一输入两次输出完全一致"
和 UPGMA 指导树的已知值会立刻抓到任何偏差）。

**距离模型**（每个都注明公式与适用性，`p-distance` 不做校正）：

| 模型 | 公式 | 边界处理 |
|---|---|---|
| `p-distance` | `d = 差异位点 / 比较位点`（缺口/简并如何处理**明确写**：按对缺失跳过） | 无 |
| `jukes-cantor` | `d = −3/4·ln(1 − 4/3·p)` | `p ≥ 0.75` → 记 `saturated: true`，`d` 取上限并**在输出里点名** |
| `kimura-2p` | `d = −1/2·ln(1 − 2P − Q) − 1/4·ln(1 − 2Q)` | 参数越界 → 同上（不抛错、不静默） |
| `tn93` | Tamura-Nei：按转换/颠换分组 + `ln` 的两项修正 | 同上 |

**树构建**：
- `upgma`（平均连接，分子钟假设）；
- `nj`（Saitou & Nei 邻接法，**真实现**：Q 矩阵、成对合并、分支长度由 `d(i,u) = d(i,j)/2 + (r_i − r_j)/(2(n−2))` 给出）。

**支持度**：`bootstrap`（默认 **0**，即不重采样；建议 100–1000）：对 MSA 列**有放回重采样**、
重建树、把每棵重复树的**演化支集合**（按序列 id 集合）与主树比对计数 → 每个内部节点 `support`。
再给 `consensus`（`strict` = 支持度 100%，`majority` = >50% 贪心共识，`greedy` = 依次加入不冲突的多数支）。
`bootstrap_seed` 显式暴露，**同一种子两次运行必须字节一致**（测试断言）。

**Newick I/O**：`toNewick` 输出带分支长度与 `support` 标签（`内部节点标签 = 支持度`，标准做法）；
`parseNewick` 能读回自己写出的（**往返一致**断言），也容忍常见第三方写法（引号名、空白、`.0`、科学计数）。

**渲染**（`renderTreeSvg`）：`layout` = `rectangular`（默认，直角树）/ `circular` / `unrooted`（等角辐射），
`scale_bar`、`show_support`、`support_threshold`（低于阈值的支画成虚线）、可选叶标签与比对长度。
**只画 `svgpng` 支持的构造**。

**参数**：`sequences`（数组）或 `fasta`/`path`（工作区 FASTA）、`method`、`distance_model`、
`bootstrap`、`seed`、`consensus`、`root`（`midpoint` 可选）、`output_path`（`.nwk`）、
`svg_path`、`auto_view`、`attach_image`。

**输出**：`newick`、`tree`（节点树：`{ name, children, length, support }`）、`distance_matrix`
（方阵 + 标签）、`method`、`distance_model`、`saturated_pairs[]`、`bootstrap_replicates`、
`consensus`（若请求）、`svg_path`、`nwk_path`、`imbalance`（可选：树的形状统计——叶数、深度）。

**规模上限**（明确报错而不是 OOM）：序列数 ≤ 200；比对长度 ≤ 20000；`bootstrap × n²` 预算检查。

**冒烟测试**：
(i) 4 条人工序列、`p-distance` 手算矩阵（逐格断言）；
(ii) 同一夹具 `jukes-cantor` 手算（含一个 `p ≥ 0.75` 的饱和对 → 断言 `saturated` 标记）；
(iii) UPGMA 的拓扑与分支长度手算（4 条：((A,B),(C,D)) 的期望高度）；
(iv) NJ 在**同一夹具**上的拓扑与 `upgma` 不同（钉住"NJ 真的实现了"而不是 UPGMA 换名）；
(v) Newick 往返（`toNewick` → `parseNewick` → 结构逐节点相等）；
(vi) `bootstrap=20, seed=42` 两次运行输出**完全一致**，且明显姊妹对的 support 高于随机对；
(vii) `majority` 共识与手算支集合一致；
(viii) SVG 逐元素断言（叶数、标签文本、`rectangular`/`circular` 两种布局、支持度阈值虚线）；
(ix) 错误路径 5 条（序列 < 2、序列数超限、未知模型、未知 method、Newick 语法错）。

---

## 5. `molbio_pcr_simulate` — in-silico PCR / 引物对搜索

**模块**：`pcr.mjs`。**主入口**：`simulatePcr(template, primerPairs, options)`。

**算法**（Primer-BLAST / `seqkit amplicon` / EMBOSS `primersearch` 的语义，纯 JS）：

1. 对模板**双链**扫描：正向引物扫顶链，反向引物的反向互补扫顶链（等价于扫底链），
   每个位点记录 `start/end/strand/mismatches/mismatch_positions/3prime_mismatches`。
2. 允许 `mismatches`（默认 0，可设 1–3）；**3' 末端 `3prime_exact` 个碱基默认必须完全匹配**
   （默认 3，可设 0–10）——这是"引物能不能延伸"的关键，明确暴露而不是隐式。
3. 每个"正向位点 × 下游反向位点"配对 → 产物：`size`、`start/end`、两引物的结合位点与错配数
   （图上分别标注）。**环状模板**（`circular: true`）跨原点配对（复用 `plasmid`/`methylation` 里已有的环状坐标环绕逻辑）。
4. **IUPAC 简并**：引物与模板都按 IUPAC 相容判定（复用 `lib` 的集合语义），N 视为匹配但在输出里标注。
5. **错引导/mispriming 屏幕**：额外提供 `screen_templates`（如载体序列）→ 逐条报告命中数与产物。
6. **凝胶图**：把命中产物按大小映射成泳道条带（`plot.renderGel` 复用）+ 可选 `ladder`；
   `product_size` 窗口过滤之外的一律列出但标记 `out_of_range`。

**参数**：`template`（序列或 `path`）、`primer_pairs`（`[{name, forward, reverse}]`）、`mismatches`、
`three_prime_exact`、`min_size`/`max_size`、`circular`、`max_products`、`screen_templates`、
`gel_path`、`auto_view`、`attach_image`。

**输出**：每个引物对的 `amplicons[]`（`size`/`start`/`end`/`forward_site`/`reverse_site`/错配明细/
`on_target`）、`total_products`、`off_target_count`、每对的 `verdict`（`specific` / `multiple_bands` /
`no_product`）、`product_sequence`（可选，存 FASTA `save_path`）。

**冒烟测试**：固定 200 bp 夹具 + 一个"正好扩出 100 bp"的引物对 → 断言产物 size/坐标/序列逐字符；
把引物引入 1 个内部错配 → 0 错配时无产物、`mismatches: 1` 时出现且错配位置正确；3' 端错配 → 默认被拒、
`three_prime_exact: 0` 时被接受（**这条是"引物能不能延伸"的核心语义**）；环状模板跨原点产物；
双产物（错引导）夹具 → `verdict = multiple_bands`、`off_target_count` 正确；凝胶 SVG 条带数/位置断言；
错误路径 5 条。

---

## 6. `molbio_gc_composition` — CpG island、GC/AT skew 与组成报告

**模块**：`composition.mjs`。**主入口**：`gcComposition(sequence, options)`、`renderCompositionSvg(...)`。

**算法**（全部有公开阈值，逐项写在输出里）：

1. **CpG island**（Gardiner-Garden & Frommer 1987）：滑窗（默认 100 bp，可设 200），
   岛 = 长度 ≥ `min_length`（默认 200）**且** GC% > `gc_threshold`（默认 50）**且**
   `obs/exp CpG ≥ ratio_threshold`（默认 0.6）；相邻/重叠窗口合并成区间；
   同时给出 **Takai & Jones (2002) 严格口径**（≥500 bp / GC > 55 / obs·exp > 0.65）作为可选 `criteria: 'gardiner' | 'takai'`。
2. **GC skew** = `(G−C)/(G+C)`、**AT skew** = `(A−T)/(A+T)`，逐窗口；
   **cumulative skew** 的极小/极大 = **ori/ter 的经典指示**（明确标注这是"指示"不是判定）。
3. **组成报告**：单/双/三核苷酸频率（含 `CpG obs/exp`）、`GC123`（若给了 CDS 坐标）、
   Shannon 熵、语言复杂度（`linguistic complexity`）、`N50/L50`、窗口 GC 曲线。
4. **图**：三个面板——GC 含量曲线 + island 阴影区、cumulative GC skew（带 ori/ter 标记）、
   二核苷酸频率条形（或 GC 直方图）。

**参数**：`sequence`/`path`、`window`、`min_length`、`gc_threshold`、`ratio_threshold`、`criteria`、
`top_words`、`svg_path`、`auto_view`、`attach_image`。

**输出**：`cpg_islands[]`（start/end/length/gc_percent/obs_exp）、`gc_skew_windows[]`、
`cumulative_skew`（数组）、`ori_hint`/`ter_hint`（窗口索引 + 序列坐标 + 明确标注为提示）、
`composition`（各阶频率 top-N）、`gc_percent`、`entropy`、`complexity`、`n50`/`l50`、`svg_path`。

**冒烟测试**：手工构造 300 bp 序列，其中 220 bp 是 GC 55% 且 CpG 富集 → 断言 island 的精确 start/end/length
与 `gc_percent`/`obs_exp` 手算值；一个**只有 GC 高而 CpG 不富集**的对照区（不得判为岛，钉住 `obs/exp` 条件
不是装饰）；Takai 口径下同一序列**不**出岛（口径真的生效）；cumulative skew 单调段的手算值 + ori/ter 指向正确；
二核苷酸计数手算；N50/L50 手算；熵与复杂度手算；SVG 面板与阴影区断言；错误路径 4 条。

---

## 7. 接线与发版清单

### 7.1 `index.mjs`
- 新增 import；在 `// ── v19: bench analysis ──` 段落定义 5 个工具（用现有 `define()`，`safe` 按是否写文件声明）。
- 5 个新工具都进 `apply()` 的 `tools` 数组（注册顺序影响提示里的呈现，按"常用在前"排）。
- `PROMPT_SECTION` 增补一段：**什么时候用它们**（"读质量好不好 → `fastq_qc`"、
  "基因能不能表达 → `codon_usage`"、"这对引物还会在哪扩增 → `pcr_simulate`"、
  "这段是不是启动子/起点 → `gc_composition`"、"这些样品谁跟谁近 → `phylogenetic_tree`"），
  并写明 **CAI/Nc/skew 都是估计值、树的 bootstrap 支持度不是 p 值**（沿用 README 的诚实口径纪律）。

### 7.2 `package.json`
- `version`: `0.10.0` → `0.11.0`；
- `files` 白名单**必须**加：`fastq-qc.mjs`、`codon.mjs`、`phylo.mjs`、`pcr.mjs`、`composition.mjs`、`svgio.mjs`
  （漏了就是"装完却没这个功能"的静默失败——v18 的 CHANGELOG 专门记过这条教训）；
- 新增 `test:bench` 之类脚本或在现有 `test:unit` 里挂上新套件。

### 7.3 preset（route-B 与复制渠道）
- 新建 `preset/molbio-lab/plugins/dsh-molbio-tools-v19/`：把 29 个模块（v18 的 23 个 + v19 改动的
  `index.mjs` / `msa.mjs` + 6 个新模块）拷进去，**其余逐字节相同**；
- `preset/molbio-lab/agent.cordis.yml`：`tool-molbio` 行 `v18` → `v19`，并把顶部注释里的 "52 tools" 改成 57 与新的分组词；
- `node test/preset-health.mjs` 必须 `OK`。

### 7.4 测试（发布时为 10 个套件，全绿才算完成——新增了 `test/svgio.mjs`）
- `test/smoke.mjs`：+5 个工具的已知值断言块（上文各节列出）、`attach_image` 计数 **11 → 15**、
  工具总数日志 52 → 57、输出 schema 由现有通用循环自动覆盖；
- `test/svgpng.mjs`：把 4 张新图加进"真实产物必须落在支持子集内"的清单，并加**像素级**断言
  （质量箱线的 IQR 边界像素、凝胶条带行有墨迹、树图的叶标签墨迹框、island 阴影区在给定 x 区间非白）；
  `--preview` 出口导出 4 张新图供**人眼复核**（v18 的规矩：改画法后必须这样看一遍）；
- `test/contract.mjs`：上文的格式绑定修复 + 新守卫；
- `test/client.mjs` / `panel-render.mjs` / `client-mount.mjs` / `drift-probe.mjs` / `preset-health.mjs`：
  预期**不需要改**（客户端产物与组合结构未动）——这正是它们要证明的"改动面收得住"。

### 7.5 文档
- `README.md`：52 → **57**（标题、目录、工具表、方法学各节的模型口径）；新增 5 个工具的条目与
  "典型用法示例"里的自然语言请求；**明确写出新图可以 `attach_image`**；把 §3 的否定清单（BAM/BLAST/ML 树等）
  按 survey 建议显式声明为 out of scope 并写明 blocker；
- `CHANGELOG.md`：新增 `[0.11.0]` 段落（设计决定、算法口径、测试方式、发版要点），
  以及 alpha.2 漂移修复的说明；
- `docs/maintainer.md`：路线图 v19 段落改为已完成、把"已完成的方向（历史）"补一行、
  记录 5 张新图的生成与"必须人眼复核"的入口、以及 `svgio.mjs` 的宿主专用约束。

---

## 8. 验收标准

1. `node --run test` **10 个套件全绿**（施工前是 8/9，contract 因 alpha.2 漂移是红的）。
2. `node test/smoke.mjs` 打印 `registered 57 tools`。
3. `node test/preset-health.mjs` 输出 `OK`，且 `agent.cordis.yml` 的 `tool-molbio` 指向 v19。
4. `node test/svgpng.mjs --preview <dir>` 导出的 12 张图（8 张旧 + 4 张新）**逐张人眼看过**，
   `unsupported` 与 `missing_glyphs` 均为空。
5. `git status` 干净（v18 目录**未被修改**——用 `git diff --stat -- preset/molbio-lab/plugins/dsh-molbio-tools-v18` 证明）。
6. 至少一次用**真实提示**在 "Molecular Biology Lab" 模式里的验证（若你愿意在本机重启 profile 后试一条，
   例如 `molbio_pcr_simulate` + `attach_image`），作为 v18 CHANGELOG 里那条"没验证到的一环"的延续证据。

---

## 9. 实现后的偏差（施工记录，供对照）

计划与落地不完全一致的三处，都是施工中发现的**真实情况**，不是偷工：

1. **§4 写的"复用 msa.mjs 的 UPGMA/k-mer 距离"只做到一半**。`msa.mjs` 里的 `kmerDistances` 与
   `upgmaGuide` 是私有函数，且 `upgmaGuide` 返回的是**合并顺序列表**（供渐进比对用），
   没有分支长度、叶名或支持度，改造它成 `buildTree` 需要的形状会同时改动 v15 起的所有比对输出。
   **所以 phylo.mjs 自己实现了 k-mer 距离与真正带分支长度的 UPGMA**（不碰 msa.mjs），
   并由 `test/smoke.mjs` 断言两者的 k-mer 公式**在同一夹具上给出同一个数**——公式不许悄悄漂移。
   `msa.mjs` 在本次发布中**一个字节都没改**。
2. **preset 目录的改动文件是 `index.mjs` / `lib.mjs` / `protein.mjs` + 6 个新模块**，
   不是计划里写的 `index.mjs` / `msa.mjs`。原因是 (1)（msa 未改），加上两处必要的：
   `lib.mjs` 导出 `CODON_TABLE_BY_NAME`（让密码子家族从**同一张**遗传密码表推导，不再手抄）、
   `protein.mjs` 导出 `CODON_USAGE`（让测试能断言优化表与频率表不打架）。
   这两处导出使 `lib.mjs`/`protein.mjs` 变动，**因此客户端产物必须重建**（计划里没预料到这一步）。
3. **新增了计划里没有的两项守卫**：`test/svgio.mjs`（共享助手自成一档，16 项）与
   `preset-health.mjs` 的**版本目录镜像检查**（"升级了却什么都没变"是模块缓存规则要防的静默失败，
   而任何挂载检查都看不见它）。后者在本次发布中**当场抓到了一次**未同步的 `index.mjs`。

另外**计划外发现并上报**：渐进比对会丢掉无法安放的末端残基（`msa.mjs` 既有行为）。
v19 不改比对器，改为在建树工具里逐个序列核对残基覆盖度并 WARNING 点名，修复记进路线图（v20 候选）。
