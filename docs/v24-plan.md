# 0.24.0 施工计划（已实施）

> 状态：**已实施（0.24.0）**。实际范围 = survey #11 + #12 + 接头表 RNA→DNA 静默错修复；
> #9 / 2.9b / 2.9c 未纳入。下面的探索记录与备选方案保留原样，便于对照“计划 vs 落地”。
> 0.23.0 已提交并推送（`4050aa6`）。

## 0. 一句话结论

**0.24.0 建议做 survey #11 + #12（若接受边界，再加 #9 的 perfect-duplex 子集）；
2.9c 放到 0.25.0；2.9b 暂缓，先解决宿主侧写回 RPC。**

| 候选 | 是否进 0.24.0 | 理由 |
| --- | --- | --- |
| survey #11 载体/接头污染筛查 | **建议加入** | 纯计算、已有接头表可复用、S–M、可直接加 benchmark |
| survey #12 FASTQ 修剪/过滤 | **建议加入** | 现有解析器齐备，只缺写出与修剪层；M、用户价值高 |
| survey #9 双链热力学 | **可选（只做 perfect duplex）** | 现有 `duplexThermo` 可导出；完整错配表/DMSO 是另一项工作 |
| 2.9c 结构预览 | **0.25.0** | 可行且不需要宿主 RPC，但解析器 + 客户端查看器是 M–L，和上面三项同版风险偏高 |
| 2.9b 文献库写回 | **暂缓** | `workspaceFiles` 明确只读；需要新增宿主 Typert Remote + 并发契约，属于架构项 |

## 1. 评估口径

沿用本仓库的既有约束：零运行时依赖、纯 JS、无外部二进制/数据库；工具行为变化必须
更新 benchmark；客户端改动必须重建 `lib/client.js` 并通过四个客户端套件；不允许为了
方便绕过 `ctx.fs`/sandboxPolicy。

## 2. 逐项探索

### 2.1 2.9b 文献库写回：被“只读 Remote”挡住

现状：

- `molbio_paper_*` 工具通过 `papers.mjs` 的 `loadLibrary`/`saveLibrary` 读写 `papers.json`；
  `addPapers`/`updatePaper`/`removePaper` 已定义去重与字段合并语义。
- 面板的 Papers 页只调用 `ctx.remote.workspaceFiles.read`，是刻意只读的
  （[client-panel.md](client-panel.md) §3）。
- DSH 的 `workspaceFiles` 服务在包 README 里写明 **“this service exposes no mutations”**，
  类型里也只有 `read` / `readBytes` / `stat` / `list` / `changes`。
- 本包客户端半**没有**宿主侧 RPC；这是为了避开 Typert Remote 的版本耦合而做的取舍
  （[client-panel.md](client-panel.md) §3）。

所以“面板里改笔记/标签”不是一个 UI 小功能，而是：

1. 在宿主侧新增一个 Typert Remote 服务（或让面板走与工具相同的写路径）；
2. 定义乐观版本号/串行化队列，避免与 `molbio_paper_update` 并发时丢更新；
3. 客户端增加对该 Remote 的注入与失败降级；
4. 处理 panel-only 包在没有该宿主服务时的行为。

**结论：不在 0.24.0 做。** 如果要做，先做一个只含 `describe`/`mutate(expectedVersion)` 的
宿主 Remote spike，再谈 UI；不要先做表单。

### 2.2 2.9c 结构预览：可行，且不需要宿主 RPC

DSH 的文档预览容器提供了两条可复用路径：

- `ctx.documentPreviews.register({ id, extensions, priority, title, loading })` 注册元数据；
- 在 keyed 座位 `sidebar.right.tab.document` 下用同一 `id` 注册正文；
- 正文收到 `resourceAddress` 与 `content`；`loading: 'bytes-complete'` 时
  `content.kind === 'bytes'`，可直接 `TextDecoder` 解码 PDB/mmCIF/SDF/MOL 文本。

这与本包“浏览器里跑自己的纯模块”的模式一致，不需要新增宿主 RPC。需要新建：

- `structure-preview.mjs`：PDB `ATOM/HETATM`、mmCIF `_atom_site`、SDF/MOL V2000
  （V3000 可后续）解析；Cα 轨迹/键的 2D 投影（PCA 或给定 2D 坐标）；SVG。
- 客户端正文：注册 preview + keyed body；空/坏/超大文件降级为说明；不抛异常。
- 测试：纯解析器已知坐标/键数；客户端 stub 驱动 preview 注册与渲染；contract 计数更新。
- 文档与 CHANGELOG；面板包 `0.1.8 → 0.1.9`（客户端产物变了）。

**结论：技术上可行，但规模是 M–L，建议单独作为 0.25.0 的主功能。** 0.24.0 若也做，
会把“纯工具版”变成“工具 + 新查看器”双线，测试面太大。

### 2.3 survey #9 双链热力学：可做子集，完整版不急

现状：

- `lib.mjs` 已有 SantaLucia 1998 NN 表、`primerTm`（含 von Ahsen Mg²⁺ 等效盐校正）、
  `duplexThermo`、`deltaG37`、`duplexTmFromThermo`；后三者目前是模块私有。
- `molbio_primer_check` 只报 3' 端 5-mer 的 `end_stability_kcal`，没有整条双链的
  ΔH/ΔS/ΔG°37。

可低成本交付的 **perfect-duplex 子集**：

- 输入一条链（另一条按反向互补生成），或两条链并校验完全互补；
- 输出 `delta_h_kcal`、`delta_s_cal`、`delta_g37_kcal`、`tm_celsius`、盐条件；
- 自互补链的 `Ct` 因子单独处理；
- 明确写“只支持完全互补双链；错配、凸起、给定二级结构、DMSO 未建模”。

完整版需要 Allawi/SantaLucia 错配表（转写 + 独立校验）、loop 表与 DMSO 经验校正，
是 M 级且容易“数字看起来对、其实不可互换”。**建议：0.24.0 只在接受上述边界时加入；
否则留给后续专门版本。**

### 2.4 survey #11 载体/接头污染筛查：最合适的 0.24.0 候选

现状：

- `fastq-qc.mjs` 已有 `ADAPTERS`（Illumina Universal/Small RNA、Nextera、PolyA/PolyG）
  与 read-level 的 adapter content 面板。
- **已发现一个现有静默错**：Small RNA 5' 的条目是 RNA（`GUUCAG…`，含 U），而
  `adapterContent` 直接拿它去 `indexOf` DNA reads；正向分子永远匹配不上，只有它的反向互补
  能命中其中一条。实测两条（DNA 正向/反向互补）只报 1 条。修法是筛查前把表归一化成 DNA
  （U→T）或分别生成 DNA 正向/反向 needle；#11 应把这条一起修，并加双向断言。
- 但没有独立工具，也没有载体骨架签名；不能对单条序列/组装结果做筛查。

建议实现：

- 新建 `contamination.mjs`：把 `ADAPTERS` 移到这里并从 `fastq-qc.mjs` 再导出（保持兼容），
  增加 `VECTORS`（pUC/pBR322、pET、pcDNA、Gateway attB/attR 等短签名）。
- `screenContamination(sequenceOrEntries, { maxMismatches, sampleReads })`：
  正/反向互补、位置、链、错配数、命中条目；序列输入与 FASTA/FASTQ 路径都支持。
- 工具 `molbio_contamination_screen`；默认 exact，`max_mismatches` 可选 0–2。
- 输出明确写“短签名筛查，不是 BLAST/全库比对；未命中不等于无污染”。

规模 S–M；新增 1 个工具、1 条 benchmark；不需要客户端改动。
风险是短签名假阳性/假阴性，必须把表来源、长度和局限写进描述与 README。

### 2.5 survey #12 FASTQ 修剪/过滤：用户价值最高，但要把边界切清楚

现状：

- `seqio.mjs` 有 `parseFastq`（容忍多行）与 `toFasta`，**没有** `toFastq` 与修剪层；
- `molbio_fasta_fastq` 只做 stats/extract/convert/qc；`molbio_fastq_qc` 只读不写。

建议先做**一个**工具 `molbio_fastq_trim`，覆盖：

- 3' 滑窗质量修剪（窗口均值阈值）与 5' 端低质量修剪；
- poly-G / poly-A 尾部修剪；
- 3' 接头 / 5' 引物精确或 seed 匹配修剪；
- 最小长度、最大 N、可选 subsample；
- Phred+33/+64 输入（输出保持同一编码）；
- 写 FASTQ 或 FASTA（`ctx.fs` + sandboxPolicy）。

明确不做：paired-end overlap merge、复杂 semiglobal adapter alignment、UMI 处理
（这些是另一个规模；不要在一个工具里假装做了）。

规模 M；新增 1 个工具、1 条 benchmark；不需要客户端改动。
测试应钉住：每条 read 的修剪后长度/质量、poly-G/A 边界、adapter 位置、过滤计数、
输出 FASTQ 四行结构与 round-trip。

## 3. 推荐的 0.24.0 范围

**主选（低风险、纯工具）：#11 + #12。**

- 工具数 62 → **64**；benchmark 63 → **65**；覆盖 64/64。
- 新增 `contamination.mjs`、`fastq-trim.mjs`；`seqio.mjs` 增加 `toFastq`。
- `seqio.mjs` 新增 `toFastq` 会进入浏览器半，因此两个客户端产物需重建；面板包 0.1.8 → 0.1.9（行为未变，只是产物字节变了）。
- 文档四处计数 + README 工具表 + benchmark tasks + CHANGELOG/history/roadmap。

**可选加项：** #9 的 perfect-duplex 子集（工具数 65、benchmark 66），前提是接受
“不支持错配/DMSO/指定二级结构”的边界，并在描述里写明。

**不在 0.24.0：** 2.9b（宿主 RPC + 并发）、2.9c（M–L 客户端查看器）、#9 完整错配表。

## 4. 施工顺序（若批准主选）

1. `contamination.mjs` + 表 + `molbio_contamination_screen`；smoke 已知值；
2. `fastq-trim.mjs` + `toFastq` + `molbio_fastq_trim`；smoke 已知值；
3. 两条 benchmark 任务 + `verifications.mjs` invocation；`--offline` 先绿；
4. `test/benchmark-coverage` 64/64；`test/benchmark-profile` 工具数；
5. README/preset 描述/index 顶部注释/agent.cordis.yml 注释四处同步；
6. `npm test`、`bench --offline`、定向模型 benchmark（`--tools contamination_screen,fastq_trim`）；
7. CHANGELOG 0.24.0、docs/history、roadmap；版本 0.24.0；commit。

## 5. 风险与开放问题

- **#11 的签名表**：短签名会假阳性；必须给出来源、长度、默认 exact、未命中声明。
  需要避免复制有许可证负担的长载体序列。
- **#12 的“修剪到什么程度”**：滑窗阈值、poly-G 最小 run、adapter 最小匹配长度都要
  有默认值与边界测试；不要一次把 Trimmomatic/fastp 的所有功能塞进来。
- **#9 的自互补 Ct 因子**：若做，需用已知序列钉住公式，否则会和 `primerTm` 的
  非自互补假设悄悄分叉。
- **2.9c 的 documentPreviews 注入**：若在 0.25.0 做，先验证 `ctx.inject(['documentPreviews'])`
  在没有该服务的 panel-only profile 中会安全跳过；不要把整个面板 entry 变成硬依赖。
- **benchmark 成本**：每条新任务都是 full-only；发版前用 `--tools` 定向跑，不默认全量。

## 6. 备选方案（若 0.24.0 想要“看得见”的功能）

把 0.24.0 改成 **2.9c + #11**：结构预览作为主功能，#11 作为配套纯工具；
#12 与 #9 推到 0.24.1/0.25.0。这个方案的用户可见价值更高，但客户端测试面明显更大，
且 0.24.0 的发版周期会更长。默认不推荐。
