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
增删改查往返、v12 错配容差（精确优先不劣化、无解→有解救援、双链错配映射不变式、
3' 关键区保护与放开、跨内含子 spliced/genomic 双坐标错配报告、参数校验错误路径）。

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
- 引物设计的错配容差（v12 已完成：`max_mismatches`/`max_3prime_mismatches`/`mismatch_3prime_zone`；3' 末端不错配，默认避开 3' 关键区，错配逐条报告并计入排序罚分；同时修复了 `resolveDesignOptions` 丢弃 `region_start/region_end` 的旧 bug）
- Golden Gate 完整模拟（IIS 酶 + 自定义突出端 + 多片段组装）
- 文献库的浏览器端面板
- 序列比对 / 保守性分析
