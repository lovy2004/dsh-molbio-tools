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
node test/smoke.mjs
```

冒烟测试通过 mock 注册表运行全部 39 个工具，并用 harness 自身的
`assertSupportedJsonSchema` / `validateJsonSchemaValue` 校验每个输出 schema 与返回值；
覆盖已知值用例（EcoRI 酶切、ΔΔCt=-3 → fold 8、GenBank/SnapGene 解析、引物对一致性、
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
超范围片段、非法 ladder 报错）。

## 发布与更新流程

preset 渠道（受 ESM 模块缓存约束）：

1. 修改包根代码并跑 `node test/smoke.mjs`；
2. 把 `.mjs` 文件复制进**新的版本目录** `preset/molbio-lab/plugins/dsh-molbio-tools-vN/`
   （绝不在已发布目录里原地改文件），并同步修改
   `preset/molbio-lab/agent.cordis.yml` 的插件行目录名；
3. bump `package.json` 的 `version`，commit + push（bundle 渠道天然免疫模块缓存：
   每个发布版本在 node_modules 中都是独立目录）。

## 路线图（可选扩展）

- 质粒图谱的浏览器内实时面板（需要客户端打包管线，当前版本以 SVG 文件交付）
- 引物设计 Primer3 对齐（v12 已完成）：错配容差（`max_mismatches`/`max_3prime_mismatches`/`mismatch_3prime_zone`；3' 末端不错配，默认避开 3' 关键区，错配逐条报告并计入排序罚分）；结构筛查改为 Primer3 同款模型（self-any/self-end 比对分、发夹/二聚体 NN→Tm 47 °C 阈值、末 5 碱基 ΔG/GC、GC clamp 0-3 分级）；mispriming 非特异结合检查；顺带修复 `resolveDesignOptions` 丢弃 `region_start/region_end` 的旧 bug
- 设计工具暴露盐/引物浓度旋钮（v13 已完成）：`na_mm`/`mg_mm`/`dntp_mm`/`primer_nm` 贯通 Tm 模型与发夹/二聚体折叠浓度，输出 `conditions` 回显
- 目标位置偏好（v13 已完成）：`target_position`/`target_penalty` 按较近引物 3' 端距离罚分，普通与跨内含子设计均支持
- Golden Gate 完整模拟（v13 已完成）：IIS 酶 + 自动唯一/非回文/非互补 4 bp 突出端设计 + 多片段组装 + 订购片段 + 特征平移 + 出图；载体盒子位点保留在骨架
- 限制酶目录查询（v13 已完成）：`molbio_enzyme_lookup` 双链向切点（IIS 反向识别位点）
- 虚拟琼脂糖凝胶（v13 已完成）：`molbio_virtual_gel` SVG + ladder
- 文献库的浏览器端面板
- 序列比对 / 保守性分析
