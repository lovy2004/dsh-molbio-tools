# 路线图（Roadmap）

本文是**往哪走**。候选池与"为什么不做"的否定清单见
[capability-gap-survey.md](capability-gap-survey.md)（40 条排序候选 + 必做 top-5，
逐条标注是否需要外部二进制/参考库/网络与实现规模）。
已经做完的版本见 [history.md](history.md)。

排期不是承诺；每条候选后面的括号是**规模量级**（S = 一个模块内，M = 新模块 + 测试，
L = 需要新机制或外部资源）。

---

## 1. 当前状态（0.13.1）

- 57 个 `molbio_*` 工具，零依赖，随 preset 分发（见 [README](../README.md)）。
- 离线测试金字塔 + 组合漂移守卫全绿；`benchmark/` 提供**模型使用**维度的评估
  （见 [benchmark/README.md](../benchmark/README.md)）。
- 基线：DSH **0.1.7-alpha.2**。

---

## 2. 最近的候选（按"沉默的错"优先）

本仓库的历史偏好很明确：**优先修"已经在产品里、但不报错的错"**，而不是再加一个功能。
理由见 v20 计划的开头——工具集的价值取决于输出能不能被信任。

### 2.0 `molbio_design_primers` 的引物朝向（**最高优先级——已确认的功能缺陷**）

benchmark 查出的真实缺陷：返回的引物对把 forward/reverse **标反了**，`F` 在下游
（201-222）、`R` 在上游（105-124），按原样送进 `molbio_pcr_simulate` **不产生产物**。
正确的两条分子就在同一份输出里（把叫 `R` 的那条取反向互补即真正的正向引物）。
证据与复核方法见 [benchmark/README.md](../benchmark/README.md) 的 Findings。

- 修的地方：引物设计引擎返回 `forward`/`reverse` 时的朝向处理；
- **必须同时补回归测试**：设计出的每一对，按原样送进模拟器必须得到**恰好一个产物**。
  这类"每个数字都对、但两个数字之间的关系错了"的缺陷，只有把两个工具**串起来**才看得见；
- 修好之后，`qpcr-primers` 任务可以把"哪条是 forward"重新钉回去。

### 2.1 `molbio_methylation_check` 的表与 NEB 不一致（**数据复核**）

工具把 BamHI 判为 `impaired by dam`（`GGATCC` 内含 `GATC`），而 NEB 列 BamHI 为对 dam
**不敏感**。需要对着 REBASE 复核整张表——尤其是"仅因位点包含 `GATC` 就判 Dam 敏感"
的那一类酶。详见 [benchmark/README.md](../benchmark/README.md) 的 Findings。

### 2.2 比对后处理套件（M）

`conservationAnalysis` 已给出共识/逐列 identity/熵，缺的是**修剪与覆盖度视图**：
IUPAC 共识、缺口比例修剪、同一性矩阵、逐列覆盖度。survey 第 6 名。

### 2.2 批量分析 + 表格导出（M）

survey 第 7 条：对工作区里所有匹配文件跑同一项分析并出 CSV。
牵连点是"写文件"路径已经齐备（`ctx.fs` + sandboxPolicy），主要是参数设计。

### 2.3 `svgpng.mjs` 的旋转多行文本（M）

v20 给**矩形**布局折了行，但**环形/扇形**布局的旋转标签仍按整行绘制——旋转文本没有按真实
字宽测过，硬折会算错行数。真修法是让折行也知道旋转，或给径向标签改用别的排布
（沿切线/半径分层），并补像素断言。属于"画面正确性"那一类，优先级高。

### 2.4 Cas12a/Cas13 等 PAM 家族（M）

`pam` 参数已能传 `NNRT`，缺**家族特定的评分曲线与几何校验**（PAM 位置、种子区定义、
crRNA 长度差异）。需要参考表，不需要外部二进制。

### 2.5 gRNA 基因组级脱靶（L）

当前把传入序列当参考。基因组规模需要先建一次索引再复用（索引的生命周期、内存上限、
跨调用缓存都是新机制），且**不能**引入外部二进制（本包的零依赖约束）。

### 2.6 多重 PCR 的温度梯度/浓度配平建议（S/M）

`molbio_multiplex_check` 已报告互扰；缺的是"给一组引物建议退火温度与各引物浓度"这类
可执行结论。纯计算。

### 2.7 TaqMan 的 MGB / 双标记探针与订购 CSV（S/M）

v16 的 CRISPR 已有订购 CSV 先例，可直接复用格式。

### 2.8 浏览器面板的候选（客户端半，不动 preset 目录）

- 给 `molbio_sequence_logo` / `molbio_grna_design` 等工具加**调用卡**（同一套
  `presentationMeta` + 卡片模式，上线前先跑 `test/client.mjs` 的抢座位顺序那一层）；
- 文献库**写回**需先定并发契约（当前只读）；
- 结构文件的浏览器内预览（`.pdb/.cif/.sdf/.mol`）：`ctx.documentPreviews.register` +
  keyed 座位是**容器**，不是现成的 3D 查看器——要么只做 2D 投影（Cα 轨迹/二级结构条带），
  要么单独估工。

---

## 3. 技术债（明确的"欠着"）

### 3.1 `png_path`：等上游给 fs 缝加上二进制写入

v18 想做"工具写一个工作区 PNG 文件"而**不能**：`dsh-fs` 明文写着
*Text-only mutations by contract*，`dsh-fs-local` 的 `writeText → writeFileAtomic` 把字符串
按 UTF-8 落盘（用 latin-1 夹带字节会被替换而损坏），读取还会以 `subarray(0, 8192).includes(0)`
拒收 NUL。绕开它有两条路（直接 `node:fs`、起子进程写盘），两者都逃出"所有写入经 `ctx.fs`"
这条纪律（见 [rules.md](rules.md) 第 5 条）。

**触发条件已经埋在测试里**：`test/contract.mjs` 有一条断言盯着"工作区仍不能存二进制文件"。
哪天它失败，就是上游加了二进制写入——那时才该回头补 `png_path`（工作区 PNG 文件）。
在那之前 `attach_image` 是唯一通路。

### 3.2 benchmark 的覆盖面

- 现在 15 条任务覆盖 11 个工具；**57 个工具里的多数还没有任务**。
- 没有断言 **`attach_image` 交付的图片内容**（只当参数用），也不加载客户端产物。
- 单模型、单次运行：**不是排行榜**，报告里已写明。要拿它做版本间比较，需要固定随机性
  （温度/种子）与多次重复——当前没有做，也不假装做过。

### 3.3 preset 组合的手工维护

`preset/molbio-lab/agent.cordis.yml` 是上游 `standard` 的手工副本，靠
`test/preset-health.mjs` 的逐行结构比对看守（见 [workflow.md](workflow.md) 第 3 节）。
上游若提供"引用 + 覆盖"机制，这项维护可以消失；当前没有。

---

## 4. 明确不做（避免重复勘察）

- **computer use / browser use 的 agent 侧能力**：无截图/鼠标/键盘工具，无 OS 辅助功能树，
  无 OCR；生态里的实验包需要视觉路由 + 附件 + 凭证 + 用户批准，且换不来计算能力，
  只换来操控网页/桌面（如网页版 Primer-BLAST、IDT 下单界面），却让"浏览器控制"与
  "实验记录"同处一个会话。不进 Molecular Biology Lab 预设。
- **agent 驱动浏览器终端**：无 `dsh-tool-terminal`，且面板明确不把输出转给模型。
  `ctx.computerUse`/`ctx.browserUse` 这类 seam 只允许**一个** provider 注册，
  第三方插件即便在未来版本也不能自带一个并行实现去抢。
- **把 57 个工具做成全局可见**：bundle 安装 ≠ 工具全局可见是**设计如此**（工具多了会占
  提示预算）。真要全局可见需要自己加一层宿主行，而那会让专属模式里的同一行变成死行。
- **持久 shell 进 preset**：收益有限、风险明确（工具名冲突要 disable 一次性那行，
  且需要未经验证的 `isolate: { terminals: true }` 分组），详见
  [history.md](history.md) 的"v18 候选 3"。
