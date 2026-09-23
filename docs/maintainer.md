# 维护者文档（Maintainer Notes）

面向插件维护者与贡献者的入口。终端用户请看 [README](../README.md)。

> **本文在 v0.14.0 被拆开。** 原来这一份 626 行的文档把"不能违反的规则""怎么操作"
> "未来方向""历史教训"混在一起，于是发布纪律在**同一份文件里出现了两遍**（一次在
> 「发布与更新流程」，一次在末尾的「发版时唯一容易漏的一步」），两处内容已经**不一致**。
> 现在按**读者要回答的问题**分成四份，每份一个职责，交叉引用而不是复制：

| 文档 | 回答的问题 | 什么时候读 |
| --- | --- | --- |
| **[rules.md](rules.md)** | 什么**不能**违反？ | 写代码、改 preset、发版本之前 |
| **[workflow.md](workflow.md)** | **怎么做**？跑什么、按什么顺序？ | 开发、测试、发布、DSH 升级之后 |
| **[roadmap.md](roadmap.md)** | 接下来**往哪走**？ | 选题、评估候选、判断"要不要做" |
| **[history.md](history.md)** | **已经发生了什么**？教训是什么？ | 想改一条规则之前（先看它是怎么换来的） |

其余文档：

| 文档 | 内容 |
| --- | --- |
| [benchmark/README.md](../benchmark/README.md) | 性能/可用性评估：模型能不能找到并用对工具 |
| [client-panel.md](client-panel.md) | 浏览器内面板：产物格式、服务契约、上限、验证方式、已知限制 |
| [capability-gap-survey.md](capability-gap-survey.md) | 能力缺口调查：40 条排序候选、必做 top-5、以及"想做但不可行"的确切阻断原因 |
| [v20-plan.md](v20-plan.md) / [v19-plan.md](v19-plan.md) | 当时的施工设计文档，保留原样以便对照"计划 vs 落地" |
| [route-b.md](route-b.md) | 安装渠道 B 的历史记录（0.1.7-alpha.1 起该渠道已废弃） |
| [client-pipeline-exploration.md](client-pipeline-exploration.md) | 浏览器内面板的可行性与实现路径调研 |
| [CHANGELOG.md](../CHANGELOG.md) | 变更日志（包版本 ↔ 历史 preset 版本目录对照） |

---

## 60 秒速览

- **包**：`dsh-molbio-tools`，零依赖 DSH 插件包，**57 个 `molbio_*` 工具**。
- **基线**：DSH **0.1.7-alpha.2**；`package.json` 版本 0.13.1。
- **两条分发渠道**：根包（工具 + 面板）与 `packages/molbio-panel`（只面板），
  **两个独立的 npm 条目**，必须分别发布。
- **工具只在专属模式里出现**（设计如此）：bundle 的 `cordis.patch.yml` 是**空列表**，
  57 个工具由 preset 层承载，只会挂进 "Molecular Biology Lab" 模式。
- **测试**：`npm test` = 插件（`smoke`）+ 画面（`svgpng`/`svgio`）+ 客户端四套件 +
  DSH 契约（`contract`）+ 组合（`preset-health`）+ 漂移守卫（`drift-probe`）+
  benchmark 的 profile 守卫与**离线期望值校验**。
- **benchmark**：`npm run bench` 用真实模型跑 15 条任务，分
  `tools_ok` / `args_ok` / `answer_ok` 三项判分；`npm run bench:offline` 零成本校验期望值。

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
├── svgio.mjs        # 共享绘图助手（几何 + 折行，进客户端产物）
├── font-metrics.mjs # 字宽度量（宿主侧专用，不进客户端产物）
├── svgpng.mjs       # SVG→PNG 光栅化器（内置折线字体 + 自写 PNG 编码；仅宿主侧用）
├── build/           # 浏览器半源码与零依赖打包器（client-bundle.mjs 是 CLI，client-bundle-core.mjs 是生成逻辑）
├── lib/client.js    # 客户端产物（exports["./client"]，由 npm run build:client 生成）
├── packages/molbio-panel/ # 面板专用包（只面板、不带工具）
├── preset/molbio-lab/     # 专属模式 preset：agent.cordis.yml 是行清单（手改这里）
│                          #   preset.patch.yml 由 build/preset-patch.mjs 生成
├── benchmark/       # 可用性评估：tasks.json + 判分器 + headless profile 推导
│                    #   （README.md 是入口；reports/ 与 scratch 工作区不进 git）
├── test/            # 冒烟 + 光栅化器 + 客户端/组合检查 + preset 漂移守卫 + benchmark profile 守卫
├── docs/            # 维护者与实现文档（rules / workflow / roadmap / history 是本目录的骨架）
└── cordis.patch.yml # bundle 的第一层补丁（当前为空列表；工具由 preset 层承载）
```

---

## 与官方插件规范的一致性

本插件受"零依赖、随 preset 分发"约束，注册**裸工具定义**（无法 import `defineTool`），
因此自行实现了官方约定中的等价行为的逐项对照，以及三处**已标注的合理偏差**——
见 [rules.md](rules.md) 第 6 节。
