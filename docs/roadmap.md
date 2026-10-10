# 路线图（Roadmap）

本文是**往哪走**。候选池与"为什么不做"的否定清单见
[capability-gap-survey.md](capability-gap-survey.md)（40 条排序候选 + 必做 top-5，
逐条标注是否需要外部二进制/参考库/网络与实现规模）。
已经做完的版本见 [history.md](history.md)。

排期不是承诺；每条候选后面的括号是**规模量级**（S = 一个模块内，M = 新模块 + 测试，
L = 需要新机制或外部资源）。

---

## 1. 当前状态（0.18.0）

- 57 个 `molbio_*` 工具，零依赖，随 preset 分发（见 [README](../README.md)）。
- 离线测试金字塔 + 组合漂移守卫全绿；`benchmark/` 提供**模型使用**维度的评估
  （见 [benchmark/README.md](../benchmark/README.md)）。
- 基线：DSH **0.1.7-rc.1**。
- **benchmark 交出的前两条缺陷已在 0.16.0 修完**（引物朝向、甲基化参考表），
  见 [history.md](history.md) 的 v0.16.0 段与 [CHANGELOG](../CHANGELOG.md)。
- **图表能力已完整交付**：0.17.0 落地折线/直方图/箱型图与 CSV/TSV 读取层，
  0.18.0 落地小提琴/火山/热力图与连续色带 —— `molbio_plot` 现共 **8 种图表**（见 2.10）。

---

## 2. 最近的候选（按"沉默的错"优先）

本仓库的历史偏好很明确：**优先修"已经在产品里、但不报错的错"**，而不是再加一个功能。
理由见 v20 计划的开头——工具集的价值取决于输出能不能被信任。

### 2.0 ✅ 已修（0.16.0）`molbio_design_primers` 的引物朝向

`forward`/`reverse` 曾**标反**（F 在下游、R 在上游），按原样送进 `molbio_pcr_simulate`
得到 **0 个产物**。修法与"为什么只有串联测试看得见"见 [CHANGELOG 0.16.0](../CHANGELOG.md)。

**遗留的一条同源问题（未改，故意）**：`molbio_design_intron_primers` 用的是**另一个约定**——
它把两条引物都报成**剪接后转录本的 sense 子串**（这样 `exon` / `junction_left` /
`junction_right` 几何、剪接 vs 基因组双坐标错配报告、3' 尾错配检查才能统一读在**一条**序列上）。
代价是：它报的 `reverse` **不是**要订购的那条分子，真正的反向引物是它的反向互补，
而且 `forward` 在 `reverse` **下游**。这是**可用性瑕疵、不是沉默的错**
（没有任何工具把这个对送进模拟器），所以没有跟 `designPrimerPairs` 在同一版里一起改。
要动它就得同时改渲染、错配报告与 `test/smoke.mjs` 的 sense-substring 断言。

### 2.1 ✅ 已修（0.16.0）`molbio_methylation_check` 的表与 NEB 不一致

根因是"位点里含 GATC/CCWGG ⇒ 该酶敏感"这条构造规则（15/29 条与来源不符），
修法与逐酶证据见 [CHANGELOG 0.16.0](../CHANGELOG.md)；`build/rebase-audit.mjs` 可重新推导。

### 2.2 比对后处理套件（M）

`conservationAnalysis` 已给出共识/逐列 identity/熵，缺的是**修剪与覆盖度视图**：
IUPAC 共识、缺口比例修剪、同一性矩阵、逐列覆盖度。survey 第 6 名。

### 2.3 批量分析 + 表格导出（M）

survey 第 7 条：对工作区里所有匹配文件跑同一项分析并出 CSV。
牵连点是"写文件"路径已经齐备（`ctx.fs` + sandboxPolicy），主要是参数设计。

### 2.4 `svgpng.mjs` 的旋转多行文本（M）

v20 给**矩形**布局折了行，但**环形/扇形**布局的旋转标签仍按整行绘制——旋转文本没有按真实
字宽测过，硬折会算错行数。真修法是让折行也知道旋转，或给径向标签改用别的排布
（沿切线/半径分层），并补像素断言。属于"画面正确性"那一类，优先级高。

### 2.5 Cas12a/Cas13 等 PAM 家族（M）

`pam` 参数已能传 `NNRT`，缺**家族特定的评分曲线与几何校验**（PAM 位置、种子区定义、
crRNA 长度差异）。需要参考表，不需要外部二进制。

### 2.6 gRNA 基因组级脱靶（L）

当前把传入序列当参考。基因组规模需要先建一次索引再复用（索引的生命周期、内存上限、
跨调用缓存都是新机制），且**不能**引入外部二进制（本包的零依赖约束）。

### 2.7 多重 PCR 的温度梯度/浓度配平建议（S/M）

`molbio_multiplex_check` 已报告互扰；缺的是"给一组引物建议退火温度与各引物浓度"这类
可执行结论。纯计算。

### 2.8 TaqMan 的 MGB / 双标记探针与订购 CSV（S/M）

v16 的 CRISPR 已有订购 CSV 先例，可直接复用格式。

### 2.9 浏览器面板的候选（客户端半，不动 preset 目录）

- 给 `molbio_sequence_logo` / `molbio_grna_design` 等工具加**调用卡**（同一套
  `presentationMeta` + 卡片模式，上线前先跑 `test/client.mjs` 的抢座位顺序那一层）；
- 文献库**写回**需先定并发契约（当前只读）；
- 结构文件的浏览器内预览（`.pdb/.cif/.sdf/.mol`）：`ctx.documentPreviews.register` +
  keyed 座位是**容器**，不是现成的 3D 查看器——要么只做 2D 投影（Cα 轨迹/二级结构条带），
  要么单独估工。

### 2.10 ✅ 图表八种全部落地（0.17.0 第一批 3 种，0.18.0 第二批 3 种 + 色带）

`molbio_plot` 现有 8 种 `kind`：柱状/散点（内联数组）+ 折线/直方图/箱型/小提琴/火山/热力图
（读工作区 CSV/TSV）。第二批的实现要点与踩过的坑：

- **小提琴图**：高斯核密度（Silverman 带宽，取 `min(σ, IQR/1.34)` 以抗离群点）。**坑**：
  网格必须跨**数据范围**；第一版把网格写成 0..1，样本在 22 附近、带宽 0.28，每一项都在 80 个
  带宽之外，`exp` 下溢成 0，整条曲线全零。
- **火山图**：只做 `-log10(p)` 展示变换与阈值标注，**不做任何统计检验**。测试用"效应大但 p 无用"
  与"p 好但无效应"两个基因钉住这一点——只看其一都会把它们当成命中。
- **热力图**：一格一个 `<rect>` + **连续色带**（`svgio.mjs` 新增 `colorRamp`/`COLOR_RAMPS`）；
  光栅化器不支持 `<g>`/`<linearGradient>`，所以渐变只能这样画。宽表与长表两种版式都支持。
  **两个坑**：色标坐标先算好（第一版用整幅绘图区再外挂色标，标签被推出画布）；
  色带与格子必须同向（第一版格子对、色带反，读图会得出相反结论）。
- 缺口色用中性灰而不是色带中点，"没测"不能读成"中等值"。
- 硬约束（三种共用）：光栅化器**只支持** `rect/line/circle/polygon/polyline/path/text`，
  `<g>` 与 `<linearGradient>` 会进 `unsupported`（`test/svgpng.mjs` 断言真实产物里必须为空）。
  每张图各配一条 benchmark 任务，并进了 `test/charts.mjs` 的 `sampleDocuments()`，
  让"没有 unsupported / 没有缺字"那条断言覆盖到它们。

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

- 52 条任务覆盖 **57/57 个工具**（0.15.0 起由 `test/benchmark-coverage.mjs` 机器断言；
  core 档 14 题）。**但多数工具只出现在一条任务里，覆盖是浅的**——见
  [benchmark/README.md](../benchmark/README.md) 的"What this benchmark does NOT measure"。
- 没有断言 **`attach_image` 交付的图片内容**（只当参数用），也不加载客户端产物。
- 单模型、单次运行：**不是排行榜**，报告里已写明。要拿它做版本间比较，需要固定随机性
  （温度/种子）与多次重复——当前没有做，也不假装做过。
  **图表的可用性尤其受这条限制**：图表类任务各只跑一次，分数只能当样本。

### 3.3 preset 组合的手工维护

`preset/molbio-lab/agent.cordis.yml` 是上游 `standard` 的手工副本，靠
`test/preset-health.mjs` 的逐行结构比对看守（见 [workflow.md](workflow.md) 第 3 节）。
上游若提供"引用 + 覆盖"机制，这项维护可以消失；当前没有。

### 3.4 绘图助手有两份（已知，刻意）

`plot.mjs`（柱状/散点/凝胶）早于 `svgio.mjs`，自带一份 `escapeXml` / `niceStep` /
`validateNumbers`；`svgio.mjs` 里也有同名同义的实现。0.17.0 的新图表**一律基于
`svgio.mjs`**（`charts.mjs`），旧两种**原样未动**——这样新代码不添新债，而既有柱状/散点的
输出保持逐字节不变（`test/svgpng.mjs` 与 benchmark 的期望值都盯着它）。

统一两份助手是**真正的清理**，但要同时改动已通过像素断言的旧输出，属于"改了必须重跑
benchmark"的那一类；等下一次不得不动 `plot.mjs` 时一并做，不要为整洁而单独开一次风险。

0.18.0 的字体改动又加了**一条同类的重复**：`FIGURE_FONT` 在 `svgio.mjs` 里是导出常量，
而 `plot.mjs` 本地复制了一份（它不 import svgio）。两处注释都写明"改一处要改两处"。
这同样等上面那次统一一起消掉——那时 `plot.mjs` 会直接 import `FIGURE_FONT`。

### 3.5 ✅ 已修（0.18.0）`svgpng.mjs` 的"浏览器半"守卫曾靠子串嗅探

`test/svgpng.mjs` 原用 `bundle.includes('svgpng')` / `includes('node:zlib')` 断言客户端产物里
没有光栅化器。**断言是对的**（光栅化器 import `node:zlib`，进浏览器会炸），但实现是**对产物
文本做子串搜索**，因此**任何注释里出现这两个字面量都会误报**——0.18.0 就真的踩了一次：
`font-metrics.mjs` / `svgio.mjs` 都在浏览器半，它们的文档注释提到光栅化器，于是守卫失败，
而光栅化器根本不在依赖图里。当时的应急处理是**改注释措辞**。

**0.18.0 已改成结构性断言**（`build/client-bundle-core.mjs` 导出 `moduleIdsFromArtifact`）：
从产物自己的加载表 `__molbio_modules["id"] = () => {` 把**注册的模块 id 读回来**，
于是问题变成"光栅化器**在不在**这个集合里"，而不是"文本里有没有这个字符串"。
实现上还**显式跳过注释**（行注释与块注释都跟踪），因为打包器原样嵌入每个模块的源码，
注释里的假注册是真会出现的输入——不跳过就等于把刚删掉的误报又请回来。

守卫现在四件事一起断言：产物没有注册光栅化器、**但确实注册了**与它共用绘图路径的
`svgio.mjs` 与 `font-metrics.mjs`；产物注册的每个 id 都是打包器声明过的；模块图里也够不到
光栅化器；以及**机制本身仍然会拒**（临时写一个 import `node:zlib` 的模块，断言打包器报
`must stay Node-free`）——最后这条是关键，否则哪天守卫被改钝了，前几条观察的是**当前**图，
照样全绿。

> 这条守卫能证明自己会失败：把 `svgpng.mjs` 的名字加回 `font-metrics.mjs` 的注释并重建，
> 产物里确实出现了该字符串，而**新守卫照样通过**（旧守卫在这一步会失败）。
> 同一次改动里，`renderBundle` 也加了**构建期自检**：产物注册的模块必须等于本次模块图走到的
> 集合，不等就直接拒绝出包。

> 顺带说明：既然守卫不再看文本，`svgio.mjs` / `font-metrics.mjs` 注释里**可以**正常写
> `svgpng.mjs` 了，"措辞规则"已从 README 移除。

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
