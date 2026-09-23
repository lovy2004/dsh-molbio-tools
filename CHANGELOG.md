# 变更日志（Changelog）

本仓库有两套版本号，请在提 issue 或对照本文档时区分：

- **包版本（`package.json` / npm / git tag）**：遵循 semver，如 `0.5.1`。
- **preset 版本目录（`dsh-molbio-tools-vN`）**：**已于 0.13.0 废弃并从仓库删除**（见该条）。
  历史上 DSH 的 ESM 模块缓存按**文件 URL** 缓存，而 preset 里的插件行写成相对路径
  `./plugins/dsh-molbio-tools-vN/index.mjs`，因此每次插件代码变更**必须新建目录**。
  0.1.7-alpha.1 上那条相对路径**不再被 import**（preset 能挂载，却一个工具都加载不了）；
  改为按**包名**引用后模块缓存问题随之消失——没有拷贝，也就没有需要保持同步的版本目录。
  下文历史条目里出现的 `vN` 目录保持原样，作为当时的记录。

## [0.15.0] — 2026-09-23（benchmark 覆盖全部 57 个工具；查出引物方向缺陷）

**工具数与插件行为均未改动**（57 个工具，领域模块一行未改）。这一版把上一版建立的 benchmark
从"12 个工具、15 题"扩到**57/57 个工具、49 题**，并把"改功能必须改 benchmark"写成机器守卫。

### 1. 覆盖：12 → 57 个工具

49 个任务分在 9 个文件里（`benchmark/tasks/*.json`，按文件名顺序拼接），每个任务声明
`covers`。**新增守卫 `test/benchmark-coverage.mjs` 断言 57/57 全覆盖**——加工具不加任务
直接红。它还守住 fixture 的**前提**（Golden Gate 载体必须无 BsaI 位点、诱变模板必须仍能
设计出引物）与 tier/占位符健全性。

**分档**：`core` 14 题（`npm run bench`，一个能力领域一个代表）、`full` 49 题
（`npm run bench:full`）。分档的理由是成本差一个数量级，而该跑哪档取决于改了什么。

### 2. 查出并记录一个真实的插件缺陷

**`molbio_design_primers` 把 forward/reverse 标反了。** 这是 benchmark 第一次查出一个
**功能性**缺陷（前几轮查出的全是 benchmark 自己的问题）：

```
tool F: ATTACTCCTGCTCTTCCCATAC   201-222   ← 等于正链 201-222
tool R: CACTACTCCTCTGTACGCAC     105-124   ← 等于 rc(正链 105-124)
amplicon: 105-222 (118 bp)
```

`F` 在 201-222、`R` 在 105-124，也就是 **F 在 R 的下游**——两条引物朝外延伸，
**按工具打印的样子送进 `molbio_pcr_simulate` 得到 `0 product(s)`**。正确的那一对确实在
这份输出里：把工具叫 `R` 的那条取反向互补，就是真正的正向引物；手工按扩增子跨度构造
（`F = top(105-124)`、`R = rc(top(201-222))`）同一个模拟器报 `specific — 1 product(s) of
118 bp`。**这是返回值的标注/朝向缺陷**，不是评分或 fixture 问题。

发现过程值得记：**是模型发现并说出来的**（"the designer returned these two molecules with
F/R reversed … the pair as printed does not amplify"），随后用 `pcr.mjs` 直接复核确认。

**状态：只记录，未修。** 修它属于引物设计引擎的朝向处理，且需要自己的回归测试
（"设计出的一对引物按原样必须模拟出恰好一个产物"）。在修好之前，`qpcr-primers` 任务
**刻意不断言模型把哪条叫 forward**，只断言两条分子与扩增子大小。详见
[benchmark/README.md](benchmark/README.md) 的 Findings。

### 3. 又一轮"测的是 benchmark 自己"

full tier 首跑 35/49。逐条查完，**没有一条失败是模型的错**：

| 症状 | 真实原因 |
|---|---|
| 三条正确答案被判错（`qpcr-efficiency`/`hydropathy`/`conservation`） | 判分器的 `normalize()` 只折叠空白，不折叠 **Unicode 减号 U+2212**；`/-3\.3/` 匹配不了 `slope −3.30` |
| `fasta-tools` 全线失败 | **runner 从没把任务点名的 `seqs.fa`/`reads.fq` 放进工作目录**，模型正确地拒绝瞎猜 |
| `codon-optimize` 数量/长度全错 | 任务要求"顺便去掉 EcoRI 位点"，模型传了 `avoid_enzymes`（**更对的做法**），而我钉的是不传时的数字 |
| `taqman-assay` 候选数、`conservation` 的 `source:` 标签 | 都取决于模型自己选的窗口/输入形式，**两种都对** |
| `qpcr-primers` | 就是上面那个引物方向缺陷——模型是对的，工具是错的 |

由此写下一条设计规则并写进 README：**钉住"请求所固定的东西"，不要钉"实现在某一组参数下
恰好返回的东西"**。

**修法**：`normalize()` 折叠 Unicode 减号与各种破折号；每个任务在自己的 scratch 工作区里
跑（顺带解决"每次跑完仓库根目录多出一堆 SVG/FASTA/JSON"）；把上表里的断言逐条改成
断言语义而非某次调用的数字。

### 4. 新增的两个守卫与两个 npm script

- `test/benchmark-coverage.mjs`：57/57 覆盖、fixture 前提、tier 健全、占位符全部可展开、
  `NETWORK_TASKS` 里不许有 tool 断言（联网工具的结果无法钉住）。
- `bench:full` / `bench:list:full`：跑/列出全部 49 题。

`benchmark/verifications.mjs` 是新文件：一个任务的**期望文本**在 `tasks/`，产生它的
**输入**在这里。分开放正是 `--offline` 能有意义的原因——两者不一致时会失败，而不是
"断言了工具碰巧输出的任何东西"。

### 5. 在线任务与其边界

`molbio_pubmed_search` / `molbio_pubmed_abstract` 打的是活的 PubMed API，**返回什么取决于
今天的 PubMed**，没有可钉住的值。它们的任务因此**只断言最终回答**（出现 PMID、出现标题），
并在 `verifications.mjs` 的 `NETWORK_TASKS` 里登记；守卫会拒绝"登记为在线却仍有 tool
断言"的任务。实测这两个工具在 headless profile 里**可用**（`dsh-web-search-deepseek` +
`dsh-web-fetch-http` 随 base 挂载，凭据已就位）。

### 发版清单

| 项 | 内容 |
|---|---|
| 工具数 | 57（不变） |
| 插件改动 | **无**（`index.mjs` 与所有领域模块未改） |
| 客户端产物 | **无需重建** |
| preset | 未改 |
| 新增 | `benchmark/tasks/`（9 个文件）、`benchmark/verifications.mjs`、`benchmark/fixtures.mjs`、`benchmark/_probe-all.mjs`、`test/benchmark-coverage.mjs`、`test/fixtures/pUC118.gb` |
| 改 | `benchmark/{README.md,run.mjs,score.mjs,sequences.mjs}`、`docs/{rules,workflow}.md`、`README.md`、`package.json`、`.gitignore` |
| 删 | `benchmark/tasks.json`（拆成 `benchmark/tasks/*.json`） |
| 预检 | `npm test`（13 项，含三道 benchmark 零成本门） |

## [0.14.0] — 2026-09-23（项目规范化 + 首个可用性 benchmark）

**工具数不变（57），插件行为零变化**——这一版不新增也不修改任何工具，改的是**这个项目怎么
维护**，以及**它第一次能被测量**。因此它是 minor 而不是 patch：新增了包内公开面
（`benchmark/` 目录、两个测试套件、若干 npm script）。

### 1. 文档重构：按"你要回答的问题"拆开

`docs/maintainer.md` 原来有 626 行，把"不能违反的规则""怎么操作""未来方向""历史教训"
混在一起，后果是**发布纪律在同一份文件里出现了两遍**（「发布与更新流程」与末尾的
「发版时唯一容易漏的一步」），两处内容已经不一致。现在拆成四份，每份一个职责，
`maintainer.md` 变成导航页 + 60 秒速览 + 目录结构：

| 文档 | 回答的问题 |
|---|---|
| `docs/rules.md` | 什么**不能**违反（每条都注明它是哪次事故换来的） |
| `docs/workflow.md` | **怎么做**：测试金字塔、客户端半、发布预检、DSH 升级 |
| `docs/roadmap.md` | 接下来**往哪走**，以及明确不做的清单 |
| `docs/history.md` | **已经发生了什么**、每个 bug 换来哪条规则 |

README 与 CHANGELOG 里原有的 `maintainer.md` 链接**全部保持有效**（该文件仍在）。

### 2. benchmark：第一次能回答"模型会不会用这套工具"

在这之前，仓库里**每一个检查都是离线的**：工具算得对不对（`smoke`）、图对不对
（`svgpng`）、挂不挂得上（`preset-health`/`contract`）。**没有一个能回答"模型拿到一句
自然语言的生物学请求，会不会找到正确的工具、把参数填对、把结论说出来"**——而这恰恰是
这个工具集的价值所在。新增 `benchmark/`：

- **15 条任务 / 12 个工具 / 11 个类别**（序列、引物、克隆、酶切、qPCR、比对、组成、
  实验台分析、实验算术、可视化、克制性），判分拆成**三个独立维度**：
  `tools_ok`（工具选择）/ `args_ok`（参数：读工具结果）/ `answer_ok`（结论：读最终回答）。
  拆开是因为"它失败了"不可行动，而三者指向完全不同的地方。
- **真实模型实测（dsh 0.1.7-alpha.2 + deepseek-flash，2026-09-23）**：
  **15/15 任务通过；工具选择 15/15、参数 15/15、结论 15/15**；69 次工具调用、
  2.47M tokens、355 s。报告在 `benchmark/reports/`（不进 git），跑法 `npm run bench`。
  **这个数字是单次样本，不是保证**：`benchmark/README.md` 记了一次实测的run-to-run
  差异（同一条任务两种都正确、措辞不同的回答），断言因此按**内容**而不是**措辞**写。
- **但先看下面第 3 节**：要拿到这个 15/15，先得修掉五个"测量本身的错"——第一版跑出来的
  0/15 测的是 benchmark，不是插件。
- **两道零成本离线门**（进 `npm test`）：`bench --offline` 把每条 `where: "tool"` 断言
  拿去和**工具真实渲染出来的文本**比对（不是 JSON——见下）；`test/benchmark-profile.mjs`
  逐字段比对 headless profile 与 preset 行清单，**上游加一行就会红**。
- **benchmark 的 profile 是推导出来的，不是手写的**：`benchmark/profile.mjs` 从
  `preset/molbio-lab/agent.cordis.yml` 生成 `$DSH_HOME/profiles/molbio-bench`。
  之所以要它：**`dsh-headless` 明确拒绝跑在 agent preset 下的会话**
  （*the one-shot runner does not compose*），所以工具必须以**宿主行**挂载——
  这正是本包唯一拒绝发布的形状（bundle 的 `cordis.patch.yml` 是空列表）。
  推导 + 逐字段守卫，是让这份重建不会静默漂移的代价。

### 3. 抓到并修掉的五个"测量本身的错"

这一版最贵的一课是：**benchmark 的第一版测的是它自己**。修掉的是测量工具的缺陷，
不是插件的缺陷——每一条都记进了代码注释与 `benchmark/README.md`：

1. **指令根本没送到模型**。`spawn(..., { shell: true })` 在 Windows 上**拼接** argv 而不
   转义，多行任务被截成**第一个词**（`"Save this text exactly…"` → `Save`）。第一次完整
   运行 15 题全废，而唯一症状是模型说"序列不在对话里"。现在改为**不用 shell**、
   直接以 `process.execPath` 调 `dsh` 的 JS 入口，并把任务走 **stdin**
   （`dsh-headless` 支持），另加一次**送达 preflight**（探针 token 不回显就整体拒绝运行）。
2. **离线门和运行时用的不是同一份文本**。`where: "tool"` 断言在离线侧比对**原始 JSON**，
   而运行时的 trace **只带渲染文本**——于是离线全绿、实跑永远不可能命中。
   `scoreSuiteOffline` 现在渲染，`--offline` 真正覆盖了这条通路。
3. **`tool_result` 按到达顺序归因**。改为按 `callId` 关联；没有对应调用的结果报
   `(unattributed)`，而不是赖给隔壁那次调用。
4. **工具结果 8 KiB 截断把证据切掉了**。模型多跑 20 次网络检索后，早先的工具结果会掉出
   捕获窗口，于是断言失败而模型其实读到了。`foldEvents` 现在上报
   `resultBytes`/`resultsTruncated`，`scoreTrace` 把这种失败标成 `suspectTruncation`——
   **截断造成的失败不算模型的证据**。
5. **六条断言在给措辞打分，而不是给内容打分**。逐条修掉并写进注释：字面量 `GAATTC`
   （模型写切点记法 `G^AATTC`）、要求"2 bands"（模型正确区分了"2 个片段"与"1 kb ladder
   上实际可见的 1 条带"）、要求字面 `?`（headless 组合没有问答器，模型被要求在散文里提问）、
   以及把 `seq1/seq2` 参数顺序钉死的错配断言（`molbio_align` 的同一性是**对称的**，
   模型传 `sequence1 = read` 完全正确）。

**守卫**：新增 `test/benchmark-score.mjs`，用**真实运行的响应**（冻结在
`test/fixtures/benchmark-traces.json`，`benchmark/_freeze-trace.mjs` 可重新生成）回放
判分器，并证明**判分器自己还能失败**（callId 归因、截断上报、无工具调用必须判选择失败、
塞一条不可能满足的断言必须 FAIL）。合成 trace 抓不到上面第 5 类 bug——它们是"模型怎么
措辞"的性质，所以证据必须活过产生它的那次运行。

### 4. 仓库可移植性：清掉写死的用户路径

`test/smoke.mjs` 与 `test/map-card.mjs` 曾以
`file:///C:/Users/18771/AppData/...` 硬导入 harness 的 `dsh-tools`——**这套测试只可能在一台
机器上通过**，而且在别的机器上它会**静默导入另一个 harness**（与 `preset-health`/`contract`
校验的那个不是同一个）。`harness.mjs` 里那条 `C:\Users\18771\...` 探测路径同样只在一台机器
上是对的。现在 `benchmark/harness.mjs` 是**唯一**的 harness 定位实现
（`DSH_HARNESS_ROOT` → `npm prefix -g` → 平台惯例），`preset-health`、`drift-probe`、
`contract`、`smoke`、`map-card` 全部复用它——顺带消掉了 `drift-probe` 里那份重复的
`packageInstalled`/`importPackage`/`readComposition`（重复的 `findHarnessRoot` 能让
"变异实验"针对一个**不同的 harness** 通过，从而什么也没守住）。

### 5. 已知的插件数据疑点（记录，不判分）

`molbio_methylation_check` 把 BamHI 判为 `impaired by dam`（`GGATCC` 内含 `GATC`）；
实测中模型跑完工具后去查 NEB，报告 **BamHI 对 dam 不敏感**。任务因此**不断言模型是否同意
工具**（它做了对的事：手抄参考表就该交叉核对），但这条分歧记在
`benchmark/README.md` 的「Findings」里，作为下一版对着 REBASE 复核表的输入。

### 发版清单

| 项 | 内容 |
|---|---|
| 工具数 | 57（不变） |
| 插件改动 | **无**（`index.mjs` 与所有领域模块未改） |
| 客户端产物 | **无需重建**（`lib/`、`packages/molbio-panel/lib/` 未改） |
| preset | `agent.cordis.yml` / `preset.patch.yml` 未改 |
| 新增 | `benchmark/`（README、tasks.json、run/score/profile/harness/tools/sequences/_probe/_freeze-trace）、`test/benchmark-profile.mjs`、`test/benchmark-score.mjs`、`test/fixtures/benchmark-traces.json`、`docs/{rules,workflow,roadmap,history}.md` |
| 改 | `docs/maintainer.md`（变导航页）、`README.md`、`.gitignore`、`package.json`（0.14.0 + scripts）、`test/{smoke,map-card,contract,drift-probe,preset-health}.mjs`（复用 harness 解析、去重） |
| 预检 | `npm test`（12 项，含两道 benchmark 离线门）+ `git status --short` |

## [0.13.1] — 2026-09-22（适配 DSH 0.1.7-alpha.2；修 preset 排序碰撞）

**alpha.2 对插件是兼容的**，逐项实测过（不是"看代码觉得对"）：

| 检查 | 结果 |
|---|---|
| 10 个套件（静态契约） | 全绿；`contract` 15/15、`drift-probe` 11/11、`preset-health` 30 行 |
| 上游 `standard` preset（drift 基线） | **逐行未变**，本包行清单无需改动 |
| `dsh-agent-preset` / `-registry` 的 Config schema | **未变**（仍只要求 `id`+`plugins` / `default`） |
| **运行时**（scratch profile + 换端口起服务） | `agentPresets/list` 的 `broken` **为空**；`pluginInventory/list` 里 `tool-molbio` = **`fiberPhase: active`**，且**只**出现在 `molbio-lab`，其余四个 preset 与全局层都没有它 |

最后一行是关键：上一轮的教训是**静态 `--dump-config` 看不出 preset 是否真的活着**，所以这次按
`docs/maintainer.md` 的判据做了真实运行时验证，而不是只跑测试。

### 修复：preset 的 `order: 2` 与上游 `ptc` 撞号

上一轮给本包 preset 写的 `order: 2` **与 DSH 自带的 `ptc` 相同**（上游占用 standard=1、
ptc=2、minimal=3、cordis=4）。注册表按 `order ?? Infinity` 排序、**平手时以
`id.localeCompare` 兜底**，于是 `molbio-lab` 与 `ptc` 的先后变成字母序的偶然——实测它被排到了
**最后**，而不是列表中该在的位置。

改为 `order: 5`（上游之外的空号），顺序确定：standard → ptc → minimal → cordis → molbio-lab。

`preset-health.mjs` 增加**排序碰撞守卫**：本包 preset 的 order 若与任何上游 preset 相同即 FAIL，
并用突变实验证明它会失败（把 order 改回 2）：

```
preset-health FAILED: 1 preset order collision(s) with a shipped preset
  - order 2 is already taken by the shipped preset "ptc" (ptc.patch.yml)
```

这条守卫防的是"肉眼看不出、只在选择器里顺序怪"的那类回归。

工具仍 57；无版本目录；包版本 0.13.0 → **0.13.1**。

## [0.13.0] — 2026-09-18（适配 DSH 0.1.7-alpha.1：修掉面板读文件全坏 + preset 迁移；工具仍 57）

**这一版是被 DSH 升级"考"出来的**，两个问题都属于本仓库最在意的那一类——**测试全绿，功能却坏了**。
插件本体（57 个工具、宿主组合层）在新版上一直是好的；坏的是**浏览器面板读文件**和
**preset 安装渠道**，而现有断言恰好都盯着**旧行为**，所以没有一个红灯。

### 修复 1（严重）：0.1.7-alpha.1 上面板**打不开任何文件**

**症状**：右侧栏 Molbio 面板能看到文件列表，点任何 `.dna`/`.fasta` 都报错，质粒图谱永远画不出来。

**根因**：`readBytes()` 对**方法**做了特性探测（`readAll` 在就调它，否则调 `readBytes`），
却对**值的形态**没有探测——两条分支最后都交给 `decodeBase64Bytes()`，而那个函数**只接受 base64
字符串**：

```js
if (typeof base64 !== 'string') throw new MolbioInputError('expected a base64 string …');
```

0.1.7-alpha.1 删掉了 `workspaceFiles.readAll`，`readBytes` 成了唯一路径，而它返回的 `data` 是
**`Uint8Array`**（gateway 把原生字节抬成 base64 attachment，客户端再重组）。于是回退分支**必然抛错**。

**修法**：把 `decodeBase64Bytes` 换成 `decodeWorkspaceBytes`——**探测方法，归一化值**：字符串按
base64 解，`Uint8Array` 原样透传（不复制，大质粒零额外开销）。

**为什么没被测出来（这版的重点）**：`test/contract.mjs` 曾**断言宿主必须实现 `readAll`**
（0.1.7 上直接 FAIL），而 `test/panel-render.mjs` 的 Remote 桩件**只提供 `readAll`**——两条断言
合起来把回退分支**整个罩住了**：真机上唯一能走的路，测试里一次都没走过。所以这一版：
`panel-render.mjs` 的默认桩件改成**新版形态**（有 `readBytes`、**没有 `readAll`**），
所有既有断言现在都跑在**真机实际路径**上；另加一块**旧形态回归**（`legacyReadAll`），
两条分支都钉住。`contract.mjs` 改为钉 `read`/`readBytes`/`list` 与 gateway 的字节附件编码。

### 修复 2：preset 渠道在 0.1.7-alpha.1 上**完全失效**

0.1.7-alpha.1 移除了 `@deepseek-ai/dsh-agent-presets` 及其**目录发现**机制——
新注册表**既不扫描目录、也不接受 preset 路径**（官方 README 原文）。preset 现在是 bundle patch
里的一个 `@deepseek-ai/dsh-agent-preset` **行**，`config.plugins` 装原来的行清单。后果：

- `preset/molbio-lab/agent.cordis.yml` 成了**无消费者的孤儿**，选择器里再不会出现该模式；
- `preset/install.mjs` 往 profile 写的 `- id: agent-presets` + `config.roots` 目标行**已不存在**，
  每次组合都打印 `patch: entry "agent-presets" not found`；
- `~/.dsh/.agent-presets/molbio-lab/` 是**死副本**（且停在 v16 / 46 个工具）。

**修法**：新增生成器 `build/preset-patch.mjs`，把 `agent.cordis.yml`（**行清单**，仍是唯一手改处）
包成 `preset/molbio-lab/preset.patch.yml`，并由 `dsh.bundle.patch` 声明为**第二个 patch 层**
（宿主层 + preset 层）。**装完即出现**，不再有第 2 步、不再需要 `roots`。
`preset/install.mjs` 改为**体检工具**：验证 bundle 是否被选中、真实跑一次
`--dump-config` 确认 `preset-molbio-lab` 进了组合，并报出上述两处遗留及其清理方法。

**验证**（不是"看代码觉得对"）：`dsh --profile molbio-web --dump-config` 退出 0，
组合树里出现 `preset-molbio-lab` / `id: molbio-lab` / 33 行 `plugins`。

### 修复 3：preset 里的**相对 specifier 在 0.1.7-alpha.1 上根本不解析**

上面两项修完后，实测仍然**加载失败**——而且是只在真机上才看得见的那一种：

```
Molecular Biology Lab — 加载失败
```

真因不在本仓库的组合，而在**模块说明符的写法**。preset 的 `tool-molbio` 行原本写的是相对路径
`./plugins/dsh-molbio-tools-v20/index.mjs`（沿用 0.1.6 及更早的写法）。在 0.1.7-alpha.1 上，

- preset **能挂载**（`agentPresets/list` 无 `broken`），
- 但那一行**永远不会被 import**：roster 报
  `tool-molbio (./plugins/dsh-molbio-tools-v20/index.mjs): never started`，
  `compositionInventory` 里它的 `fiberPhase` 是 `null`。

改成**包名** `name: 'dsh-molbio-tools'` 即恢复正常（实测 `fiberPhase: active`）。顺带把
`cordis.patch.yml` 里那条宿主层 `tool-molbio` 也去掉了：它在**全局层**注册同样的 57 个工具，
与本包"工具只属于 molbio-lab 这一个模式"的设计相抵触（也是两处重复注册的来源）。
现在 bundle 的两个 patch 层分工明确——`cordis.patch.yml` **什么都不插**（为空列表，留给将来
真正宿主层的东西），`preset.patch.yml` 声明 preset 并携带工具行。

**验证方式（本轮的关键教训）**：不再只跑静态检查。用一个 scratch profile
（`--from-default-profile web` + link 本包）真起一个 `dsh web` 到另一个端口，带 cookie 认证调
`/api/agentPresets/list` 与 `/api/pluginInventory/list`，读 `broken` / `fiberPhase` 字段。
`broken` 与 `fiberPhase` 是仅有的两个能证明"preset 真的活着"的字段，静态
`--dump-config` **看不出**这个问题。

> **顺带删除的负重：`preset/molbio-lab/plugins/dsh-molbio-tools-v11…v20/`。**
> 版本目录机制是为规避**相对文件 URL** 的 ESM 模块缓存而设的：preset 行写相对路径，于是
> 每次发版都要把全部 `.mjs` 复制进一个新目录（本次删除前是 **195 个文件 / 5.2 MB**）。
> 改用包名后这个理由不复存在，十个目录与 `preset-health.mjs` 的**镜像检查**一并删除。
> 腾出的位置由一条更有价值的检查补上：**preset 行不得写相对路径**——正是本轮的真因，
> 已用突变实验证明它会失败（把 specifier 改回 `./plugins/…`，`preset-health` 立即 FAIL）。

### 测试基线的迁移

`preset-health.mjs` / `drift-probe.mjs` 的**上游基线**改成
`@deepseek-ai/dsh-web-app/presets/standard.patch.yml`（旧包的 `presets/standard/agent.cordis.yml`
已消失——`drift-probe` 之前是**直接崩溃**，`preset-health` 则因 `existsSync` 守卫**静默跳过**整段
漂移比对，等于悄悄停止看守）。两侧都通过新的 `presetPlugins()` 从 `config.plugins` 取行；
`--check` 不再允许静默跳过：找不到基线会明确告警。

一处静默陷阱顺手修掉：`drift-probe` 的 `driftText` 对**已展平**的行列表再调一次 `orderedRows`，
会重新进入每个 group 行的 `config`、把子行**发两遍**，表现为"位置 14 顺序不符"的假漂移。

工具仍 57。**不再有版本目录**：`preset/molbio-lab/plugins/` 已整体删除，preset 行按包名引用本包。

## [0.12.0] — 2026-09-18（v20：修掉比对器丢残基 + 长叶名折行；工具仍 57）

**这一版处理的是两个"沉默的错"。** 一个是**数据完整性**：渐进比对会把放不下的末端残基**静默丢掉**
（11 bp 对 10 bp 返回 10 列，第 11 个碱基消失），而系统发生学从被截断的数据出发是最坏的一类错误。
另一个是**画面正确性**：树图的长叶名被画成一行、**直接压到相邻标签上**，图看着"有东西"但读不出来。
两者都不抛错、都不影响其它套件，正是本项目反复强调的那种"全绿但错了"的故障。

### 修复 1：`msa.mjs` 渐进比对丢尾部残基（v19 发现、v20 修复）

**根因不是"忘了补缺口"，而是补错了位置。** 半全局（末端缺口免费）的评分**允许**最优路径在任一
序列末尾之前停下——对 `ACGTACGTACG`（11）与 `ACGTACGTAC`（10），DP 在 `(10,10)` 得 40 分，而在
`(11,10)` 只有 30 分，所以"丢掉最后一个 G"**确实是分数最优的选择**。真正的问题是：路径**起点之前**
的残基有 `while (i > 0)` / `while (j > 0)` 两个循环补成悬垂列，**终点之后**的残基却从来没有人发出来。
于是路径保守地选了"不碰它"，它就消失了。

修法：把端点之后的残基作为**纯悬垂列**追加到结果里（`suffixA`/`suffixB` 单独按左到右顺序收集，
避免被 traceback 末尾那一次 `reverse()` 搅乱——第一版就是踩了这个坑，输出成 `GACGTACGTAC`）。
`score` **不变**，因为悬垂列计 0 分，和被它替换掉的末端缺口同分。

- **不变式**：每条输出行去掉缺口后**逐字符等于它的输入序列**（顺序也算）。测试逐条断言这一点，
  而不是断言某个列数——列数只是这条不变式的推论。
- **`coverageShortfall` 从 `index.mjs` 抽到 `phylo.mjs` 并导出**：v19 加的"覆盖度不足"WARNING
  现在**不该再对真实输出触发**，但守卫本身必须留着（它会抓到未来的回归）。测试因此**用一个故意
  截断的行去驱动它**，证明它仍然会响——"没人见过失败的守卫不算守卫"。
- **行为变化**：从 v15 起的所有比对输出在**存在悬垂**时列数会变（变多）。等长输入**完全不变**
  （没有悬垂可补）。v15–v19 的已知值断言已逐条复核：`smoke.mjs` 里唯一钉住旧行为的那一条
  （`alignment_columns === 10`，注释写着"比对着会 pad 而不是插 gap"）**钉的正是这个 bug**，
  已改成 11 并加了"覆盖度警告必须不再出现"。

### 修复 2：`svgpng.mjs` 支持 `<tspan>` 多行文本（长叶名不再互相压）

光栅化器此前把 `<text>` 里的**任何**嵌套标签当作"这一段文本结束"，`<tspan>` 因此落进
`unsupported` 并被当作独立文本——**同一段文字被画两遍**，看起来就是两行字叠在一起。

- **解析器**：`<text>` 现在是唯一支持嵌套的地方，产出 `runs`（每个 `<tspan>` 一个）。`x`/`y`
  绝对定位与 `dx`/`dy` 相对偏移都支持；空的自闭合 `<tspan dy="14"/>` 也会推进基线（"空行"）
  ——这正是把标签折成多行的机制。
- **诚实边界**：`<tspan>` 带 `transform`、`<tspan>` 里再嵌 `<tspan>`，都**计入 `unsupported`**
  并沿用原有文本，而不是猜一个位置画出来。测试同时钉住"报告"和"不误画"。
- **`font-metrics.mjs`（新模块）**：把字体的**字宽（0.6 em）与每 em 网格数**从光栅化器里抽出来，
  这是唯一能让"排版时预留的宽度"和"真正画出来的宽度"是同一个数、不会各自漂移的办法。
  `svgpng.mjs` 与 `svgio.mjs` 都 import 它；它**不进客户端产物**（`svgpng.mjs` import
  `node:zlib`，所以浏览器半永远不能 import 这两者）。
- **`svgio.textSpanLines` / `svgio.wrapTextLines`（新助手）**：按**真实字宽**折行（而不是 v19 那个
  手写的 `字数 × 字号 × 0.62` 估算）。长标识符在**分隔符之后**断行（`_`、`-`、`.`、`|`、`:`），
  因为把 `Escherichia_coli_K12_MG1655_chromosome_complete` 从词中间劈开读起来像损坏；
  没有分隔符时按字数硬断，**绝不允许溢出预算**。折行**无损**（断点只吃掉空白）。

### 改进：树图的矩形布局给叶名真正的列宽

- 叶名按预留列宽折成多行 `<tspan>`（列宽 = 面板宽度的 40%，下限 90 px）；**字号只在必要时才缩小**
  （下限 5 px），因为把标签缩小到读不了比折行更糟。行距按"每叶一行必须放得下"来收敛。
- 折行**只在超宽时发生**：短标签是单行、几何与 v19 几乎一致。**但并非逐字节相同**——v19 用
  `字数 × 字号 × 0.62`（每字符 6.82 px @11）预留，现在用真实字宽（每字符 6.6 px），所以预留的
  标签列略宽、分支尖端相应左移几像素。这是把估算换成真值的结果，不是回归。
- 环形与扇形布局**不折行**：旋转过的文本没有按真实字宽测量，硬折会算出错误的行数；两者都在面板
  宽度外画标签，`svgpng.mjs` 对旋转运行的处理也保持原样。

### 顺带修掉：`preset.yml` 的工具数停在 52（v19 漏改）

v19 把工具从 52 加到 57，README、组合注释、工具表都改了，**唯独预设选择器里那行描述还写着
"52 个 molbio_* 工具"**——用户在整个 v19 周期看到的是错的数字，而没有任何检查会发现它。
已改为 57 并补上 v19/v20 的新能力说明。**更重要的是补了守卫**：`preset-health` 现在把
`preset.yml` 描述里的工具数与**插件真正注册的数量**对比（`toolCountDrift`，导出给 `drift-probe`
驱动），声称 52 而实际 57 会**失败并阻断发布**；同时确认"没有工具数描述的文案"不会被逼着加一个。

### 测试与验证方式

- **`test/smoke.mjs`**：v20 段改写为**残基守恒不变式**——对多组长度不等的输入，逐条断言
  `行.replace(/-/g,'') === 输入序列`（含顺序），并断言对齐列数一致；直接断言
  `coverageShortfall` 对**故意截断的行**仍然报 `u2 (10 of 11 bases kept)`。
- **`test/svgpng.mjs`（18 → 22 项）**新增四项**像素级**断言（不是文本断言）：
  `<tspan>` 三行各自落在自己的基线上、**行间是空的**（塌到一条基线上会失败）；`dy` 相对堆叠
  逐级下移、**相邻两个基线之间确实空着**（证明是移动而不是重印）；自闭合空 `<tspan>` 推进一个
  空行；`<tspan>` 的 `transform` 被**报告**而不是猜着画；以及**长叶名的树图**——扫描标签列，
  断言至少每叶两行、且 4 个标签块之间**至少留出 3 处空白间隔**（v19 的单行长标签会把这个数字
  压到 0 或 1，也就是"压在一起"）。这一条是这次修复的**图像回归守卫**。
- **`test/drift-probe.mjs`（11 项）**新增三条驱动 `toolCountDrift`：描述正确时**零噪音**
  （含"把 90+ 限制酶、2–50 条序列这类其它数字不当成工具数"）、写明 v19 那种 52 vs 57 的
  **过时描述必须被抓到**、没有工具数描述时**不被逼迫**。
- **`test/preset-health.mjs`**：新增工具数比对；镜像检查报
  `mirror OK: dsh-molbio-tools-v20 matches the package root module-for-module`。

### 发版要点

- **工具仍 57 个**（README 的工具表不变）。改动的是**正确性**，不是工具数量。
- **必须新建 preset 目录**：`preset/molbio-lab/plugins/dsh-molbio-tools-v20/`（30 个模块：
  v19 的 29 个里 `index.mjs`/`msa.mjs`/`phylo.mjs`/`svgio.mjs`/`svgpng.mjs` 有改动，
  **新增 `font-metrics.mjs`**），`tool-molbio` 行已指向 v20。
- **客户端产物已同批重建**：`lib/client.js` 与 `packages/molbio-panel/lib/client.js`
  （334.3 KB → 335.9 KB）——`msa.mjs` 在浏览器半里也用（面板的比对数据通路），改了就必须重建。
  `font-metrics.mjs`/`svgio.mjs`/`svgpng.mjs` 三者**都不进客户端**。
- `package.json`：`files` 白名单新增 `font-metrics.mjs`（漏了就是"装完却没有这个功能"的静默失败），
  版本 0.12.0；`packages/molbio-panel` 版本 0.1.1 → 0.1.2（产物已变）。
- route-B 用户重启 profile 即可；复制渠道用户请重拷 `agent.cordis.yml` 与新的 v20 目录。
- 升级说明一句话：**"比对器不再静默丢掉放不下的末端残基（每条输出行的残基与输入逐字符一致），
  系统发生树的长叶名会折行而不是压在一起；顺带修掉了预设描述里停了一版的工具数"**。

## [0.11.0] — 2026-09-18（v19：实验台分析五件套；工具 52 → 57）

**这一版补的是"实验台第一问"。** 之前 52 个工具覆盖了"设计、构建、验证"，但一个测序/分析型
用户最先问的五件事没有工具回答：**数据质量好不好**、**这个基因能不能表达**、**这对引物还会在
哪儿扩增**、**这段是不是启动子/起点**、**这些样品谁跟谁近**。方向出自
[docs/capability-gap-survey.md](docs/capability-gap-survey.md) 的"必做 top-5"，实现计划与逐项口径见
[docs/v19-plan.md](docs/v19-plan.md)。

### 新增（5 个工具 + 6 个模块）

- **`molbio_fastq_qc`**（`fastq-qc.mjs`）：读级质控——每碱基质量（均值 + **四分位/10-90 分位**）、
  每读质量直方图、每碱基 A/C/G/T/N 含量、每读 GC 分布（含 FastQC 同款**理论正态近似**叠加）、
  长度分布（含直方图与 N50）、**完整序列精确重复率**、过度代表序列、内置公开接头片段扫描、
  Q20/Q30 与"每碱基均值从第几位跌破 Q30/Q20"；另出六面板 SVG 报告。**每个数字都以数组返回**，
  报告只是同一批数字的画法。
- **`molbio_codon_usage`**（`codon.mjs`）：CAI（Sharp & Li 1987）、逐密码子 RSCU、Nc（Wright 1990
  GC3 分箱期望）、GC3/GC123、罕见密码子清单（位置 + 宿主频率 + 相对适应性）、CDS 内 CpG 观测/期望、
  隐藏终止子与起始/终止密码子检查、可选滑窗局部 CAI；宿主 E. coli / 酵母 / 人。
- **`molbio_phylogenetic_tree`**（`phylo.mjs`）：p-distance / Jukes-Cantor / Kimura 2P / **Tamura-Nei**
  校正距离、UPGMA 与**真正实现的邻接法**、bootstrap 支持度（**显式种子、同种子逐字节复现**）、
  严格/多数共识树、Newick **读写往返**、矩形/环形/扇形三种 SVG 布局与比例尺。
- **`molbio_pcr_simulate`**（`pcr.mjs`）：双链引物位点搜索、产物大小与坐标、逐位错配明细、
  **`three_prime_exact`（3' 必须精确匹配的碱基数）与 `max_mismatches` 分离**、IUPAC 简并匹配、
  环状模板跨 origin 产物、对额外模板（载体等）做错引导筛查、预期凝胶图（复用 `plot.renderGel`）。
- **`molbio_gc_composition`**（`composition.mjs`）：滑窗 GC、**两套 CpG 岛阈值**
  （Gardiner-Garden 1987 / Takai & Jones 2002）、GC/AT skew 与**累积 skew 的 ori/ter 指示**、
  16 个二核苷酸的观测/期望、词频、Shannon 熵、语言复杂度、N50/L50；出三面板图。
- **`svgio.mjs`**：4 张新图共用的绘图助手（标尺/坐标轴/面板/图例/配色）。**宿主侧专用**——
  它和 `svgpng.mjs` 都不进客户端产物，测试盯着这一点。

### 设计决定（逐条都有测试或明确口径支撑）

- **"饱和"要有解**：JC 的 p ≥ 0.75、K2P/TN93 参数非正时校正距离**在数学上没有解**。工具把该对
  记进 `saturated_pairs` 并把距离**夹到模型上限**——返回巨大假值会污染整棵树，直接报错又会拒绝
  用户合法的分析请求。
- **3' 端是独立的旋钮**：`max_mismatches` 与 `three_prime_exact` 分开，是因为生物学上它们不同
  （中段错配仍能延伸，3' 错配通常不能）。默认 3 bp 精确，测试同时钉住"默认拒绝"与"设 0 后接受"。
- **小样本不该有输出**：过度代表序列的门槛是 `max(20 reads, 0.1% × 样本)`，所以 8 条读的样本
  **合法地报告 0 条**。测试同时钉住"小样本 0 条"与"30 条样本里 24 条同一序列被报出"。
- **两张密码子表不许悄悄打架**：`codon.mjs` 新增完整的 61 密码子频率表，而 `protein.mjs` 里的
  `CODON_USAGE` 是**优化偏好**排序，两者本意不同（60 个氨基酸×宿主里有 18 个首选不一致）。
  测试因此断言三件事而不是"全等"：频率表 61 个密码子齐全、家族和为 1、优化表的首选**不是**
  罕见密码子（w 不低于家族最大值的一半）。
- **环形/扇形布局的半径是线性映射**：真实距离常在 0.01 量级，按 `depth/max` 归一化会把整棵树
  塌缩成一个点（第一版就是这样，人眼复核时发现）；现在半径在观测区间上线性铺满面板，比例尺
  负责交代真实单位。**扇形只画拓扑**并写明"长度不成比例"——等角布局本来就不编码距离。
- **诚实的 out-of-scope 清单进 README**：BAM/CRAM、比对、组装、BLAST、ML/贝叶斯树、参考库类分析
  逐条写明 blocker，并指明每类在本工具集里的本地替代品。

### 修复：DSH 0.1.6-alpha.2 漂移（两项，都会让现有安装出问题）

1. **preset 少了一行上游新增的 `tool-plugin-manager`**（`disabled: true`）。DSH 0.1.6-alpha.2 的
   shipped `standard` 预设新增该行，而本组合的"逐行结构比对"守卫**正确地拦下了发布**。
   已按上游逐行补齐（含注释位置），`preset-health` 恢复 `OK`：30 行全部可挂载。
2. **`test/contract.mjs` 绑定了 minifier 的空格**：断言写死 `ctx.slots.provideRoot({ hooks: {`
   这一**单空格拼写**，而 alpha.2 把同一调用排成四行缩进。契约没变（同一个 check 里紧跟的
   空白容忍正则一直是过的），所以这是**断言绑格式**而非产品故障。已改为空白容忍，并新增一条
   **不空转自检**：四种拼写（单行/多行/紧凑/多空格）都必须通过，而把 `hooks` 改名成 `hookz`
   必须失败——否则"放宽成不绑格式"会悄悄退化成"什么都不检查"。

### 顺带发现并上报（不是本版修复范围）

- **渐进比对会丢掉无法安放的末端残基**（`msa.mjs` 既有行为，v15 起就在）：11 bp 的序列与
  10 bp 的序列比对后返回 10 列，那条 11 bp 的序列被静默截断。v19 **不去改比对器**，但新建树的
  工具会**逐个序列核对"非缺口字符数 == 输入长度"**，不一致就在 `notes` 里 WARNING 点名
  （`u2 (10 of 11 bases kept)`）。系统发生学从被截断的数据出发是最坏的一类静默错误。
  比对器本身的修复记在 [docs/maintainer.md](docs/maintainer.md) 路线图里。

### 测试与验证方式

- **`test/svgio.mjs`（新套件，16 项）**：共享助手的几何手算值（`linearScale` 反向区间、
  `niceTicks` 的取整网格与负区间、`indexScale` 往返、panel 内缩、textRun 的可选属性、
  axis 的 x/y 两种布局、图例与配色函数），最后用**每一个助手**拼一份文档光栅化，断言
  `unsupported` 与 `missing_glyphs` 都为空。
- **`test/svgpng.mjs` 新增第 14 项「v19 图把墨迹画在数据所在的位置」**：不只断言"能渲染"，
  还按**坐标矩形采样**断言内容位置——FASTQ 报告三列面板各自有内容、树图主体与叶标签分列左右、
  扇形布局**必须画满**（塌缩成一个点会失败，这条正是半径 bug 的回归守卫）、凝胶的梯子与两条
  样品泳道各有条带、组成图的 CpG 岛阴影确实覆盖左半。八份真实产物（4 张 v19 + 原有）都进
  "真实渲染器产物必须落在支持子集内"的清单。
- **`test/smoke.mjs` 新增五个工具的手算断言块**（工具数 52 → 57，注册数由日志与
  `attach_image` 计数 11 → 15 共同看守）：FASTQ 的 8 条读夹具逐位置均值/四分位/Q20/Q30/重复率/
  接头/过度代表；密码子表的完整性与 CAI/RSCU/Nc/GC3/CpG 已知值（含"家族大小从 4 变 3 会让
  CAI 从 1.0 变成 0.4444"这条真 bug 的回归）；距离矩阵逐格手算 + 饱和夹取 + 四 taxa 的**四点条件**；
  PCR 的产物坐标/序列逐字符、错配与 3' 规则、环状跨 origin 序列、错引导双带；组成分析的岛边界/
  skew 手算值（G 富集/C 富集等长段的 ±0.5）/"高 GC 但无 CpG 不算岛"。
- **`test/preset-health.mjs` 新增镜像检查**：组合指向的 `vN` 目录必须与包根**逐字节一致**
  （多一个少一个模块都报错）。已用突变实验证明它会失败——"升级了却什么都没变"正是模块缓存规则
  要防的那种静默失败，而任何挂载检查都看不见它（旧模块照样挂得上）。
- **`npm test` 从 9 个套件变为 10 个**（新增 `svgio`）。

### 发版要点

- **工具 52 → 57**；`attach_image` 覆盖的画图工具 11 → 15。
- **必须新建 preset 目录**：`preset/molbio-lab/plugins/dsh-molbio-tools-v19/`（29 个模块：v18 的 23 个
  里 `index.mjs`/`lib.mjs`/`protein.mjs` 有改动，**新增 `svgio.mjs`** 与 5 个分析模块），
  `tool-molbio` 行已指向 v19；`node test/preset-health.mjs` 报 `OK` 且镜像检查通过。
- **客户端产物已同批重建**（`lib.mjs`/`protein.mjs` 在浏览器半里也用，改了就必须重建）：
  `lib/client.js` 与 `packages/molbio-panel/lib/client.js`。**`svgio.mjs` 与 5 个新模块都不进客户端**。
- `package.json`：`files` 白名单**必须**含 6 个新模块（漏了就是"装完却没这个功能"的静默失败），
  版本 0.11.0，新增 `test:svgio` 脚本并接入 `test:unit`。
- route-B 用户重启 profile 即可；复制渠道用户请重拷 `agent.cordis.yml` 与新的 v19 目录。
- 升级说明一句话：**"多了五个实验台分析工具（测序质量、密码子优化、系统发生树、in-silico PCR、
  CpG/GC 组成），画图工具都能把图交给模型看；另外修好了在 DSH 0.1.6-alpha.2 上 preset 少一行、
  contract 测试绑格式这两个问题"**。

## [0.10.0] — 2026-09-17（v18：让模型"看见"自己产出的图；工具仍 52）

**这一版解决的是"图给谁看"。** 之前 11 个画图工具只写 SVG：人看得见（还会自动打开），
**模型看不见**——它只能读路径和数值。harness 自带模型可见的 `read_image`（PNG/JPEG/WebP/GIF），
但不收 SVG，所以"让模型自查凝胶条带/图谱"一直差这一步。

### 关键设计决定：为什么不是 `png_path`（**原计划不可实现**）

原方案是加 `png_path` 参数、在工作区写一个 PNG 文件。**在 DSH 0.1.6-alpha.1 上这条路走不通**，
三层证据（都来自本机安装的 harness）：

1. `dsh-fs/README.md`：**"Text-only mutations by contract** — … binary-safe mutations remain
   deferred"；
2. `dsh-fs-local/lib/index.js`：`writeText → writeFileAtomic` 把调用方的**字符串按 UTF-8 落盘**
   （想用 latin-1 夹带字节会被 UTF-8 编码器替换而损坏），文本读取还会
   `subarray(0, 8192).includes(0)` 拒收 NUL——**连读回来都做不到**；
3. 全树检索**没有任何 `writeBytes`**，`FsErrorCode` 里只有 `FS_NOT_TEXT`。

绕开它只能直接 `node:fs` 或用 `ctx.get('subprocess')` 起进程写盘，两者都逃出"所有写入经 `ctx.fs`
并携带会话 `sandboxPolicy`"这条纪律，**明确拒绝**。于是改用 harness 提供的二进制安全通路：
`ctx.attachments.saveImage()` + 工具结果里的 **image content block**——这正是它自己 `read_image`
的实现方式（`dsh-llm` 的 `ImageBlock = { type: 'image', attachment: ImageAttachmentRef }`）。
`test/contract.mjs` 现在把这条链路的每一环都钉住，并**专门断言 fs 缝仍然没有二进制写入**：
哪天上游补上了，这条断言会失败，提醒维护者回头补当年的 `png_path`。

### 新增

- **`svgpng.mjs` — 零依赖 SVG→PNG 光栅化器**（宿主侧专用，`client` 产物不含它）。只覆盖本包
  会生成的 SVG 子集，**不是通用渲染器**：`rect`（含 `rx`、`width="100%"`）、`line`、`circle`、
  `polygon`、`polyline`、`path`（M/L/H/V/C/S/Q/T/A/Z，绝对与相对）、`text`（font-size/anchor/
  dominant-baseline/textLength/lengthAdjust/`rotate`）、hex 颜色、`fill-opacity`、`stroke-width`、
  `stroke-dasharray`、`stroke-linecap`，2× 超采样后盒式降采样。PNG 编码自写
  （IHDR/IDAT/IEND + 自算 CRC32，deflate 用内置 `node:zlib`）。**文字用内置折线字体**
  （6×7 网格、矢量描边、随字号缩放，无字体文件）：覆盖可打印 ASCII 与 `· ° ± — – … ≈ μ α ─`，
  **非 ASCII（例如中文标题）不会被画出来**，且会记进 `missing_glyphs` 而不是画成乱码。
  **不支持的构造一律计数上报**（未知元素、`<g>` 的 transform、`url(#gradient)` 这类画法），
  绝不静默丢弃——`test/svgpng.mjs` 断言四个真实渲染器的八份产物 `unsupported` 与
  `missing_glyphs` **都必须为空**，因此以后新增 SVG 构造会在这里失败，而不是从图里消失。
- **11 个画图工具的可选 `attach_image: true`**：`plasmid_map` / `plasmid_map_file` /
  `clone_simulate` / `golden_gate` / `grna_design` / `qpcr_efficiency` / `plot` /
  `virtual_gel` / `sequence_logo` / `helical_wheel` / `hydropathy_plot`。打开后工具把同一张图
  光栅化并提交为附件，结果里多一个 `image` 对象（`attachment_id`/`media_type`/`bytes`/
  `width`/`height`），`output.render` 在文本旁多返回一个 **image block**，模型**当场看到图**，
  不需要再走一次 `read_image`。**默认关**：不传参的调用**一个字节都不提交、结果形状完全不变**。
  报告工具（序列分析、引物设计等 41 个）**一个都没动**。
- 三条实现纪律与随之而来的测试：
  - **能力门照抄 harness 的规则**：`exec.agent.session.requestHeader().config` → provider/model →
    `ctx.get('llm').resolveModelInfo()` → 检查 `inputModalities.includes('image')`，与
    `read_image` 的 `assertImageCapableRoute` 同源（`contract.mjs` 盯着这条规则本身）；
  - **永不失败**：无附件服务 / 文本路由 / 路由解析不出 / 渲染不了 / 存储拒收，全部降级为纯文本，
    并在 `image_note` 里**点名原因**；SVG 照写、`auto_view` 照旧、调用照成功；
  - **`smoke.mjs` 覆盖 9 条**：不传参数时零提交且仍是单 text block；传了以后提交的确实是 PNG
    （签名 + IHDR 尺寸与凝胶画布手算值一致）；结果字段与第二个 block 的 `attachment` 逐字段一致；
    11 个工具逐个断言参数与输出字段、且总数恰好 11；四条降级路径各自不改成功性；附加图片时
    `render` 仍产出文本。

### 修复

- **线性质粒图谱一直被裁掉 3' 端**（真 bug，被这次的"图"暴露）：`renderPlasmidMap` 无论拓扑都写
  `viewBox="0 0 840 840"`，而 `renderLinear` 画布是 960×260、内容一直画到 x≈900——**浏览器里同样
  裁掉**（最后一个 ruler 标注与骨架末端）。现在按拓扑选画布（线性 960×260 / 环形 840×840），
  并删掉 `renderLinear` 里重复的白底矩形。`test/svgpng.mjs` 新增回归：线性图的栅格必须是 960×260
  且 **x≥880 必须有墨迹**。客户端产物已同批重建（`plasmid.mjs` 在浏览器半里也用）。

### 测试与验证方式（这一版是第一次能"看着自己的产物"验证）

- **`test/svgpng.mjs`（新套件，17 项）**：用**与编码器不同实现**的 CRC（无表位运算）与裸
  `inflate` 把字节解回像素，再做手算几何断言——rect 的四个边界像素、圆心/半径外、描边居中与
  dash 空档、`fill-opacity` 混合到中灰、`fill="none"` 不填充、`text-anchor` 三个锚点的墨迹框、
  cap height ≈0.7 em、`dominant-baseline` 居中、`textLength` 压到指定宽度、`rotate(-90)` 把基线
  转到旋转点左侧；外加确定性（同输入两次字节相同）、错误路径（非 SVG / 无尺寸 / 非零 viewBox
  原点 / 超像素上限 / CJK 缺字上报 / `encodePng` 参数校验）、以及"光栅化器不得进入客户端产物"。
  还带两个开发用出口：`--sheet <png>` 导出整张字形表、`--preview <dir>` 导出每种图各一张
  ——**改字形后必须这样人眼复核一遍**。
- **`test/smoke.mjs` 的 v18 段**（见上）与 **`test/contract.mjs` 的两个新 check**（图片交接链路
  的每一环；以及"fs 缝仍然是纯文本"这条反向守卫）。`npm test` 从 8 个套件变为 9 个。
- **人眼复核**：八份真实产物（环形/线性质粒图谱、凝胶、logo、螺旋轮、疏水性图、柱状、散点）
  与字形表都经 harness 自己的图像解码器（`read_image`）读回**逐张看过**；过程中修掉两处：
  `@` 字形画成了 `a`（螺旋轮副标题里的 `max 0.15 @ 2` 就是证据），以及上面那个线性图谱裁剪。

### 发版要点

- **工具仍 52 个**，README 的工具表不变；新增的是可选参数与一个模块。
- **必须新建 preset 目录**（插件 `.mjs` 有改动）：`preset/molbio-lab/plugins/dsh-molbio-tools-v18/`
  （v17 的 22 个模块里 `index.mjs`/`plasmid.mjs` 更新，**新增 `svgpng.mjs`**，其余逐字节相同），
  `tool-molbio` 行已指向 v18；`node test/preset-health.mjs` 报 `OK`。
- `package.json`：`files` 白名单**必须**含 `svgpng.mjs`（漏了就是"装完却没有这个功能"的静默失败），
  新增 `test:svgpng` 脚本并接入 `test:unit`。
- route-B 用户重启 profile 即可；复制渠道用户请重拷 `agent.cordis.yml` 与新的 v18 目录。
- 升级说明一句话：**"画图工具现在可以把图直接交给模型看（调用时加 `attach_image: true`）；
  工具数量与用法不变，另修掉了线性质粒图谱右端被裁掉的问题"**。

## [0.9.1] — 2026-09-17（DSH 0.1.6-alpha.1 漂移修复：**preset 曾无法挂载**；工具仍为 52）

**背景**：本仓库在 DSH `0.1.5-alpha.2` 上发布，随后机器上的 DSH 升到 `0.1.6-alpha.1`。
升级后 `npm test` 挂了 **2 项**，其中一项不是测试问题，而是**用户可见的故障**：
`Molecular Biology Lab` 预设**根本挂不上**。包版本与 preset 版本目录**均不变**（无插件 `.mjs` 改动，
工具仍 52 个）——但修复必须发出，因为现有安装会照抄包内这份组合文件。

### 修复（真实故障；`test/preset-health.mjs` 抓到，但当时只打印"drift note"并退出 0）

- **preset 引用了不存在的 provider 包**：组合里的 `workflow-worker-thread` 行指向
  `@deepseek-ai/dsh-workflow-worker-thread`，而**没有任何已发布的 DSH 安装这个包**
  （本机 `0.1.6-alpha.1` 只有 `@deepseek-ai/dsh-workflow-ptc`）。该行 `unresolvable`，
  预设 mount 失败，选择器里点开就是加载错误。已改为上游 `standard` 的
  `workflow-ptc`（`config: { provider: spawn }`，与本组合原意一致）。
- **静默的行为偏差**：`tool-ralph` 在包内组合里是**启用**的，而上游 `standard` 明确
  `disabled: true`（工具描述把 `ralph` 限制在"人明确要求"的运行，且完成判定是 worker
  自报而非独立评估）。已按上游改回 `disabled: true`。想用的话按上游注释复制一份 preset 并去掉
  `disabled`，不要在这里偷偷打开。
- **组合文件与上游逐行对齐**：吸收 `0.1.6-alpha.1` 的上游文本（`persona` 的 `suffix`/`prefix`
  顺序、`delegation` 注释、fork 注释、`present` 说明），并删掉上游已移除的
  `tool-subagent-report` 段落。现在 `git diff --no-index` 对比安装的 `standard` 只剩**一个 hunk**：
  末尾的 `tool-molbio` 行（加上文首新增的"维护契约"注释）。这本身就是漂移审计手段。

### 加固（这一版真正的"清障"成果）

- **`test/preset-health.mjs` 的漂移检查从"只比 id"升级为"比行"**：逐行比对**行序**、
  `name`、`disabled`、`isolate`、`config`，并把**漂移从 note 提升为 FAILURE**
  （v17 的 `worker-thread` 就是被"note + 退出 0"放过去的）。`tool-molbio` 是唯一允许的额外行，
  允许清单在文件顶部显式声明。
- **`test/drift-probe.mjs`（新增）**：没人见过失败的守卫不算守卫。用**变异组合**驱动
  `compositionDrift`——幻影 provider 行、被丢掉的 `disabled`、改名、改 config、改 isolate、
  丢行、多余行、行序错乱——断言每一种都被抓到，且对**当前这份组合零噪音**。
  `preset-health.mjs` 因此改为 `if (import.meta.main) await main()` 并导出该函数（Node ≥ 22，
  `package.json` 已加 `engines`）。
- **`test/contract.mjs` 的 hook-prop 规则断言不再绑定 minify 形态**：`0.1.6-alpha.1` 把
  `standardHookPropName` 从 `function $c(t){…}` 编成了**类方法** `$c(t){…}`，原来的
  "整个函数体"正则因此失败（面板本身没问题）。现在断言的是**契约**：稳定导出名
  `standardHookPropName: <symbol>` + 该符号仍实现 `use${首字母大写}${其余}` 这条规则
  （允许 `slice`/`substring`、可选括号、箭头/方法/函数三种写法）。
- **产物新鲜度检查不再依赖 `spawnSync`**：受限沙箱拒绝管道 stdio（EPERM），原检查只能
  "无法验证"——恰好是自动化发版处最需要它的时候。打包器的生成逻辑已抽到
  **`build/client-bundle-core.mjs`**（`createGenerator({ entry, baseDir }) → { order, ids, renderBundle }`），
  `build/client-bundle.mjs` 变成薄 CLI（新增 `--check`：只报告陈旧、不落盘），
  `test/contract.mjs` **在进程内**重算期望产物并与已提交文件逐字节比较。
  字节级等价已实测：重构后重跑打包器，`git status lib packages` 为空。

### 分发注意

- **route-B（已注册 preset 根，推荐渠道）用户**：组合文件是每次挂载重新读取的，
  升级包后**重启 profile 即可**，不需要重新 `add`。
- **复制渠道用户**（把 `preset/molbio-lab/` 拷到 `~/.dsh/.agent-presets/`）：请重新复制这份
  `agent.cordis.yml`（`plugins/` 目录若还在 v16/v17 可不动；组合文件的模块缓存规则不适用）。
- 本机 `~/.dsh/.agent-presets/molbio-lab/` 还留着一份 **v16 的老副本**，同样带
  `workflow-worker-thread`；route-B 生效时它不参与，但若曾用复制渠道请按上面重拷。

### 发版记录

- **工具与 preset 目录不动**：无插件 `.mjs` 改动，**没有新建 `v18` 目录**，`tool-molbio`
  行仍指向 `dsh-molbio-tools-v17`；`package.json` 的 `version` **0.9.0 → 0.9.1**（修复版），
  tag `v0.9.1`。
- 发版前按 `docs/maintainer.md` 的三步预检：`npm test`（8 套件全绿）→
  `node build/client-bundle.mjs --check`（两个产物均报 up to date）→ `git status --short` 干净。
- 升级说明一句话：**"修复在 DSH 0.1.6-alpha.1 上 Molecular Biology Lab 预设无法挂载的问题
  （工具数量与用法不变）"**。

### 仅文档：v18 路线图补入 DSH 0.1.6 新能力的可用性勘察

**不改代码、不改 preset 目录、不改包版本**，只更新 `docs/maintainer.md` 的路线图，把
0.1.6-alpha.1 的"面板内终端 / computer use"逐包核对结果写成 v18 的输入（含证据、门槛与
"不要再重复勘察"的否定清单）：

- **面板内终端：已经在用，零改动。** 浏览器终端（`ctx.terminalController` + xterm.js 标签页）随
  `dsh-web-app` 出厂即启用，与本包右栏面板**同座位共存**（靠 tab `id`/`kind`/guide order 区分，
  `id` 重复会抛异常）。它与 agent 侧的 `ctx.terminals` 是**两套互不相通的实现**，且面板
  **不把终端输出送给模型**。
- **v18 候选 1（推荐）**：给绘图工具增加**可选 PNG 输出**，让模型能自己调用 `dsh-tool-fs` 的
  `read_image` 看图谱/凝胶/logo。现状是"只写 SVG、`read_image` 不收 SVG"，所以差这一步；
  不需要视觉模型、不需要 computer use。
- **v18 候选 2**：用 `ctx.documentPreviews.register({ id, extensions, loading: 'bytes-complete' })`
  + `sidebar.right.tab.document` 座位把 `.pdb/.cif/.sdf/.mol` 放进本包自己的标签页。**范围要说清**：
  这是容器（座位/注册表/字节加载），不是现成 3D 查看器。
- **v18 候选 3（需先验证）**：持久 shell 进 preset。要加 `dsh-terminal` + `dsh-terminal-bash` +
  `dsh-tool-pwsh-persistent`；`sandbox`/`subprocess` 已在 `dsh-base`。两个硬约束：**工具名冲突**
  （`pwsh`/`bash` 与一次性工具重名，必须禁用一次性行，并同步 `preset-health` 的允许清单与组合头部）
  与**唯一待验证点**——从 preset 发布 `ctx.terminals` 需要 `isolate: { terminals: true }` 分组，
  shipped preset 有同类先例但没有 terminal 的先例。
- **明确不在本版**：computer use 的 agent 侧能力（无截图/鼠标/键盘工具、无 OCR、无辅助功能树；
  全树 `screenshot` 只出现一次且是否定句）；agent 驱动浏览器终端（无 `dsh-tool-terminal`）。
  同批勘察的 MCP（`dsh-mcp-client` 未被任何 shipped bundle 挂载；stdio server **不受文件沙箱约束**）
  与 hooks（兼容适配器，不是插件扩展点）作为备选记录在案，不进路线图主线。

### 仅文档：新增 `docs/capability-gap-survey.md`（v18 的选型依据）

不改代码、不改 preset 目录、不改工具数量的第二份规划文档：把"52 个已发布工具相对主流生信
生态缺什么"逐项过筛——九个来源家族（商业质粒/克隆套件、实验台网页计算器、Biopython/EMBOSS/
SeqKit、标准序列统计、微生物组、群体遗传、蛋白预测、比对后处理、测序 QC），每条候选都要同时
通过「(a) 对实验台真的有用于 (b) 能用几百行无依赖、无外部数据/二进制/网络/参考库的确定性算法
实现」两道筛。产出：**40 条排序候选**（含 ext?/纯 JS?/规模/价值四列）、**必做 top-5**、
**"想做但不可行"清单（每条点名确切阻断原因：二进制格式 / 参考数据库 / 模型权重 / 网络 /
算力规模）**，以及全部依赖的 URL 出处（并标注了哪些论断因 403/无正文而只算部分核实）。
它的价值不只是候选池：§3 的否定清单可以直接搬进 README 的"不做什么"，让用户不再要求本工具
做 BLAST/BAM/ML 树。

## [0.9.0] — 2026-09-13（v17：TaqMan 探针、多重 PCR、甲基化/双酶切、蛋白结构图；工具 46 → 52）

**路线图 v17 方向的第一批：五个新工具 + 一个新的 preset 版本目录**。全部为 v11–v13 引擎
之上的确定性纯计算，零依赖不变。

### 新增

- **`taqman.mjs` + `molbio_design_taqman`**：TaqMan（水解探针）测定设计。先用标准引物
  引擎设计 qPCR 尺寸的扩增子（**默认 70–200 bp**，可用 `primer_options` 覆盖），再在
  扩增子内的缺口里放探针并施加探针规则：**5' 端不得为 G**（淬灭）、探针 Tm 至少高出较热
  引物 `min_tm_delta`（默认 5 °C）、无单碱基重复/串联重复、自互补有界、且与两条引物都
  不形成稳定二聚体。每条候选给出探针序列/坐标/方向/Tm 边距/引物 3' 端距离与**逐项公开的
  排序罚分**。几何采用「扩增子两个缺口」模型：`orientation: "forward"` 从正向引物 3' 端
  向外读（标准设计），`"reverse"` 从反向引物 3' 端向外读并报反向互补——一个缺口放不下探针
  时自动回退到另一个，并在 `notes` 里说明。`primer_options` 的 snake_case 键经显式映射
  转成引擎的 camelCase（**0.9.0 开发中抓到并修掉的真 bug：不映射时用户传的窗口会被静默
  忽略而落到默认值**）。
- **`multiplex.mjs` + `molbio_multiplex_check`**：多重 PCR 互扰检查。报告（1）面板内**所有**
  引物对的 any/3'-anchored 二聚体 Tm，超过阈值（默认 47 °C）的标为 conflict；（2）每条引物
  3' 尾的**非预期退火**——自身模板上的脱靶位点（允许配置错配）与**其他模板上的完全匹配**
  （多重交叉反应；**模板序列相同的 target 视为同一个模板**，否则每条引物都会"交叉"到自己的
  扩增子）；（3）扩增子大小**是否可在胶上分辨**（<20 bp 判为 indistinguishable、<40 bp 判为
  close），以及可执行的重设计建议。
- **`protein-structure.mjs` + `molbio_helical_wheel` / `molbio_hydropathy_plot`**：
  - 螺旋轮（Schiffer-Edmundson 投影）：残基按 3.6 残基/圈（100°/残基）落在圆周上，按
    疏水/极性/酸性/碱性着色并生成 SVG；同时给出整段与**滑动窗口（默认 11 残基，Eisenberg
    标准）**的最大疏水矩 μH（Eisenberg 共识标度）、疏水残基比例与提示。字形用绝对字号 +
    `textLength` 定位，逐字形断言不超残基圆（沿用餐 0.6.0 序列标识图的教训）。
  - Kyte-Doolittle 疏水性图：滑动窗口（默认 9；跨膜段建议 19–21）、GRAVY、**达到阈值
    （默认 1.6，经典跨膜判据）的峰**及逐残基 profile，写成 SVG 并自动打开。
- **`methylation.mjs` + `molbio_methylation_check` / `molbio_double_digest`** 与
  `lib.mjs` 的两张参考表（`METHYLATION_SENSITIVITY`、`ENZYME_BUFFERS`/`BUFFERS`）：
  - **甲基化检查**：找出序列中每个 Dam（GATC）与 Dcm（CCWGG，双链向）位点，报告哪些酶的
    识别位点与之重叠，并把每个酶分类为 `cuts` / `impaired` / `blocked` / `no_site`——这正是
    "酶没问题、但用 dam⁺/dcm⁺ 宿主提的质粒切不动"的经典场景。默认检查对象是甲基化表覆盖且
    **消化酶表里确实存在**的 21 个酶（表里的 AvaII/MboI/EcoRII/PspGI/TaqI/HphI/BstNI 不在
    消化表中，报 0 位点是误导），也可传 `["common"]` 查全表。
  - **双酶切**：两个酶各自的切点/片段、合并切点与合并片段（线性/环状），以及**两者是否共用
    buffer**（标准 NEB 系列；无共用 buffer 时明确给出"顺序酶切/换用厂商双酶切 buffer"的建议），
    并标出某酶在本模板上无位点、或两酶切在同一磷酸二酯键的情形。
  - **两张表都是手工转录的速查数据**，每个结果都随附 `METHYLATION_DATA_NOTE` /
    `BUFFER_DATA_NOTE`，要求对照厂商当前表格复核后才可作为实验依据。
- **客户端半**：`build/browser-api.mjs` 把 v17 的纯计算面（甲基化/buffer 表、探针与多重
  分析、蛋白图渲染器）一并再导出，**面板本身在 v17 未改动**；产物重建（184.9 KB →
  332.9 KB），`npm run build:client` 与所有客户端测试已同步。

### 修复（实现过程中发现并修掉的真实缺陷）

- **探针几何（三次纠正，最终为"缺口模型"）**：初版把引物名字当成了模板坐标顺序，导致
  探针窗口在多数扩增子上为空；第二版把"正向引物 3' 端 + 上游引物 3' 端"混用，产出**与引物
  重叠的探针**；第三版才落到"扩增子物理缺口 + 从开缺口的引物向外读"这一条规则，并由
  smoke 对**每一条返回的测定**断言：探针等于模板切片（或反向互补）、不与任一引物重叠、
  距离正是从开缺口引物 3' 端量起、5' 端非 G、无 run、Tm/GC 在窗口内。
- **`primer_options` 全表静默失效**：见上（snake_case → camelCase 映射）。
- **几何之外的静默数据问题**：`amplicon.length` 未给坐标时序列化为 `undefined`（非 lossless
  JSON，被 harness 的输出校验拒绝）——改为字段整体缺省；`methylation` 的 `in_methylation_table`
  字段未进 schema——补齐。
- **`test/contract.mjs` 的新鲜度断言在受限沙箱下误导**：`spawnSync` 被沙箱拒绝（EPERM）时
  原来打印"the bundler runs cleanly"，容易误读成打包器崩了；现在把 spawn 失败与打包器失败
  分开报告，并给出人工核对命令。

### preset 与分发

- **新建 `preset/molbio-lab/plugins/dsh-molbio-tools-v17/`**（版本目录规则：插件 `.mjs` 有
  改动，必须新建目录），`agent.cordis.yml` 的 `tool-molbio` 行指向 v17，`preset.yml` 描述
  同步到 52 个工具。
- **`package.json` 版本 0.8.0 → 0.9.0**；`files` 白名单覆盖新增 `.mjs`（`files` 用的是包根
  相对路径，`.mjs` 逐个列出——`taqman.mjs` / `multiplex.mjs` / `protein-structure.mjs` /
  `methylation.mjs` 已加入）。
- **测试脚本跨平台化**：原来的 `"test": "node a && node b && …"` 依赖 npm 的 shell，在
  Windows 的 cmd/PowerShell 下 `npm test` 直接失败（`&&` 不是 node 的语法）。改成
  `test:unit` / `test:client:node` 子脚本 + `node --run` 串联，`npm test` 现在在
  cmd/PowerShell/git-bash 下行为一致；`docs/maintainer.md` 的预检说明同步。

### 测试

`test/smoke.mjs` 新增 v17 段（工具 46 → **52** 个注册，逐工具输出 schema 校验）：

- **TaqMan**：pUC118[1200,1800) 上 7 条测定；对每条断言几何与探针规则的不变式；钉住排第一
  的测定（序列/坐标/Tm 61.71 °C/边距 0.81/Tm 边距距离 6）与一条"缺口在反向引物一侧"的测定
  （距离 67 从反向引物 3' 端量起）；探针 Tm 与 `lib.primerTm` 同源；5 条 Tm 边距不足的
  amplicon 逐条上报；四条选项错误路径（含嵌套 `primer_options`）。
- **多重 PCR**：4 个真实引物对的固定面板——24 条引物对交互、3 条跨 target 二聚体（69.1 /
  66.03 / 61.23 °C）、大小冲突 164 vs 168 bp（indistinguishable）与 103 vs 83 bp（close）；
  相同模板不交叉、不同模板共享 3' 尾（完全匹配仅 8 bp 尾）判为交叉反应；无坐标不产生大小
  冲突；四条错误路径。
- **蛋白图**：14 残基两亲性肽的手算值（μH 0.353、窗口最大 0.584 @3、疏水 10/极性 1/碱性 3、
  首残基 90°/单位圆坐标）；69 残基蛋白的疏水图手算值（GRAVY −0.13、峰 4-10/23-27/52-59、
  首窗口 = 残基 1-5 均值、窗口 21 平滑后 2 峰）；SVG 逐字形/逐顶点断言；四条错误路径。
- **甲基化/双酶切**：手工夹具（3 个 ClaI 位点被 Dam **blocked**、BamHI **impaired**、EcoRI/
  HindIII/XbaI 可用、Dcm 位点不与选择中的酶重叠）；pUC118 全质粒（dam 15 / dcm 5、8 个可用
  酶）；EcoRI+HindIII 环状双酶切（切点 927/876 → 3111+51 bp，CutSmart 等 4 个共用 buffer）；
  无共用 buffer 的 BstXI+SmaI；无位点与共享切点两条建议；错误路径。

## [0.8.0] — 2026-09-12（安装渠道 B：把 preset 注册进 profile，升级不再需要复制）

**新增 `preset/install.mjs`**：把**已安装包内**的 preset 目录注册为 profile 的额外 preset
扫描根，补上"`dsh plugin add` 装了工具、却不出现在预设选择器里"这个缺口。配置改一次，
之后每个版本只跑 `dsh plugin --profile <p> update dsh-molbio-tools`，**不需要再复制、也不
需要再改配置**。

- 机制：在 profile 的 `cordis.patch.yml` 追加一条 `- id: agent-presets` 补丁，其 `config.roots`
  增加 `{ path: <已安装包>/preset, trust: system }`。`config` 是整体替换，因此重述 `default: standard`。
- 为什么值得做：复制渠道把 preset 冻结在复制那一刻，每次发布（版本目录规则要求新建
  `dsh-molbio-tools-vN`）都要重新复制；注册渠道的 root 路径**跨版本恒定**（`link:` 是符号链
  接、npm/tarball 是真实目录，实测从 `link:` 换成 tarball 后路径不变），升级因此只动包、不动配置。
- 脚本性质：零依赖、幂等（已注册即零写入）、写入前备份 `cordis.patch.yml`、写完用
  `dsh --profile <p> --dump-config` 自检；对没有 roster 行的 profile（headless/sdk）**先检查
  bundle 列表再明确拒绝**，而不是写一个必然被 loader 拒绝的补丁。支持 `--dry-run` / `--check`。
- 实测覆盖：组合树解析与 root 出现、幂等、`--check`、`--dry-run` 不落盘、无 roster 行被守卫、
  发现层对已安装副本判定 `healthy` 且四个内置 preset 未受影响、升级（换安装来源）后路径不变；
  补丁形状另用 harness 自己的 YAML 解析器跑 5 种边界（裸 `[]` 占位符、无尾换行、CRLF、已有条目）。
- 两个由实测抓到的坑已写进文档：新 profile 的 patch 文件是**裸 `[]`**，追加会产生第二个顶层
  节点（`end of the stream or a document separator is expected`），必须替换占位符；`roots.path`
  是 `path.resolve` 解析的，**相对路径随进程 CWD 漂移**，必须写绝对路径。
- **工具数量不变（46 个）；preset 版本目录不变**——本次只新增包内 `preset/install.mjs` 与文档，
  未改任何随 preset 分发的 `.mjs`，按版本目录规则无需新建 `v17`。
- 新增 [docs/route-b.md](docs/route-b.md)：用法、机制、升级 Runbook（含"别提前删旧 `vN` 目录"
  等三条纪律）、与复制渠道的取舍表、实测方法与已知限制。

## [0.7.2] — 2026-09-11（修复：座位未声明就注册 → DSH 拒绝启动）

**修复 HARNESS "Failed to load plugins"**（`failed to apply loader entry …(dsh-molbio-panel):
slot "tool.call.toolview" is not declared (a parent entry's children table must declare it)`）。

客户端座位只有在**拥有它的那条 entry 在自己的 `children` 表里声明之后**才存在：`sidebar.right.pane.tab`
由右栏的 `rightbar.session` entry 声明，而 `tool.call.toolview` 是 ui-tool 的
`conversation.chat.node` entry 的**子座位**。0.7.1 的卡片用裸 `ctx.slots.register()` 抢这个座位，
启动图里没有任何东西保证我们的 entry 排在 ui-tool 之后——`register()` 于是抛上述 SlotCore 异常，
异常从本包的 `apply()` 逃出即是**加载器 entry 失败**，也就是整个 Web GUI 拒绝启动（不是"少一个
tab"）。四个右栏座位当时只是碰巧安全（本包 inject 了右栏提供的服务），同样的竞态依然存在。

- 修法：**所有**座位声明改走 `ctx.slots.inject(seat, cb)`（ui-tool / ui-skill / ui-sidebar-right /
  ui-sidebar-documentpreview 都是这个写法）：座位已声明则立即执行，未声明则等声明到达，
  重声明（epoch）时先撤销旧贡献再重放，贡献随本 fiber 销毁。
- 新增 `test/slots-stub.mjs`：按 shell 的 SlotCore 语义复刻"未声明座位 `register()` 必抛
  `… is not declared (a parent entry's children table must declare it)`"与 `inject` 的等待/重放规则。
- `test/client.mjs` 改为从**一个座位都没声明**的最坏启动顺序开始：断言 `apply()` 不抛、四个右栏
  座位在声明后落地、调用卡座位一直等到 ui-tool 声明才落地，并当场复刻那条异常消息本身。
- `test/contract.mjs` 增第 10 项：钉住 shell 仍拒绝未声明座位的注册、slots 服务仍提供
  `inject(key, callback)`、官方包仍用它抢这两个座位，且**本包产物里每一处 `slots.register`
  都必须落在对应座位的 `slots.inject` 里**（数量与配对都断言）。

工具数量不变（46 个）；preset 版本目录不变（本次只动客户端产物与测试，未改随 preset 分发的 `.mjs`）。

## [0.7.1] — 2026-09-10（图谱调用卡：`tool.call.toolview`）

**新增图谱调用卡**：`molbio_plasmid_map` 与 `molbio_plasmid_map_file` 的调用**直接在对话里
画出这次产出的质粒图谱**（摘要行 + 写入路径），不再只给一个文件路径；调用失败时显示错误
文本与 Inspect 入口。

- 宿主侧：两个 map 工具新增 `output.presentationMeta(args, value)` 投影——这是官方文档
  写明的结构化数据通道（`presentResult`/`presentCall` 内置 Web 客户端不消费），且只有
  ROOT 调用会执行。SVG 随 meta 传输设 256 KB 上限：超限时改带 `svg_omitted` 与字节数，
  卡片降级为提示 + 路径（图谱仍写在文件里）。投影是纯计算（图谱标记走一份有界内存缓存，
  不读文件）且不抛——它跑在调用成功之后，抛错会把成功调用标成失败。
- 客户端侧：新增 `tool.call.toolview` 卡片（按工具名取键）。它**校验而非信任** meta：
  缺失/异种/异形/超限/失败一律降级为提示，绝不在对话里抛错；SVG 用 DOM 注入，保持可选中。
- `define()` 包装器转发 `presentationMeta`（此前只转发 schema/render，投影会被静默丢弃——
  由新测试当场抓到）。
- 测试：新增 `test/map-card.mjs`（真实工具 → 投影 → 卡片读取 → 渲染出 SVG，含四条降级
  路径）；`test/contract.mjs` 增第 9 项，钉住"工具层仍调用 `output.presentationMeta` 且只对
  root 调用"与"卡片座位仍按工具名取键"。

工具数量不变（46 个）。

## [0.7.0] — 2026-09-10（浏览器内面板：bundle 渠道 dsh.client 双面包）

**新增两个右栏面板**：**Molbio**（列出会话工作区的序列文件，选中即画图：`.dna`/`.gb`/
`.gbk` → 质粒图谱 + 特征表，`.fa`/`.fasta` → 序列标识图）与 **Papers**（把
`molbio_paper_*` 维护的 `papers.json` 渲染成可搜索的阅读列表 + 详情面板）。解析与渲染在
浏览器里跑的是本仓库自己的模块，与 Node 工具**同一份源码**——不落盘 SVG、不弹系统查看器、
不经过工具调用。

- `build/client-bundle.mjs`：零依赖打包器，产出 DSH 客户端加载器要求的 **lazy-CJS**
  产物（`window.__ModuleLoader__.load({id, factory})`）。官方 `tsdown.client.ts` 预设未随
  npm 发布，故按加载器契约复刻；同时把纯净度门禁前移成构建期检查（禁 `node:` 内建、
  禁裸 specifier、禁动态 `import()`）。**一趟构建产出两个交付包**。
- `build/browser-api.mjs` / `panel-core.mjs` / `client-entry.mjs`：浏览器安全面、面板数据
  通路（无 React、可在 Node 单测）、以及两个右栏 tab 的注册与组件。
- `packages/molbio-panel`：**面板专用包**（宿主半边空实现）——装它只加面板，不会把 46 个
  工具注入该 profile 的每个会话；`dsh-molbio-tools` 则是"工具 + 面板"通道。
- `package.json`：`exports["./client"]` + `dsh.client {platform: web, inject}` +
  两个客户端包的 optional peer；`build`/`lib`/`packages` 进入发布白名单；新增
  `build:client` 脚本。**工具侧无变化（仍 46 个）**，预设渠道与 bundle 渠道可共存。
- 测试（6 个套件）：
  - `test/client.mjs`：按加载器方式执行产物（注册形状、**注册期零全局写入**）+ 两条数据
    通路（真实 pUC118 夹具、文献库投影/搜索/错误路径）；
  - `test/panel-render.mjs`：**真实组件**在最小钩子宿主里跑完整状态机（无 React、无 DOM），
    断言列表/图谱/特征表/logo/搜索/标签/空库/坏库/卸载中止；
  - `test/client-mount.mjs`：复刻宿主侧图扫描，验证两个包能挂上、依赖可解析；
  - `test/contract.mjs`：把面板与宿主的**运行时契约**钉在已安装的 DSH 上（钩子 prop 命名
    规则、root hook 提供方、`workspaceFiles` 的方法与 wire 形状、本包自己的注册与实参顺序、
    以及发布白名单是否真的带上客户端产物）。
- 文档：新增 `docs/client-panel.md`（实现记录：产物格式、三条硬约束、服务契约、上限、
  验证边界与未验证项）。

> 说明：本版本的面板已在本地 web profile 安装并通过全部静态/契约验证，**页面内的实际观感
> 需重启一次 `dsh web` 后在右栏确认**（新插件行在启动时组合）。

## [0.6.0] — 2026-09-10（preset 目录 v16）

**序列标识图与 CRISPR gRNA 设计（路线图 v16 方向）。** 工具总数 44 → 46。

### 新增

- **`logo.mjs` + `molbio_sequence_logo`**：把保守性分析背后的逐列碱基组成画成 SVG
  序列标识图。字母高度 = 信息量 Rᵢ = log₂4 − (Hᵢ + e_n)，纵轴 bits（0-2）；堆叠高度
  按频率分配，经典配色。频率只按残基统计（缺口排除并逐列上报），简并碱基按碱基集合
  摊分权重。`small_sample`（默认开）扣小样本熵校正 e_n = (K−1)/(2·ln2·n)；
  `score_type: "frequency"` 切成纯频率图。输入 `alignment` / `sequences` /
  `fasta_path`，写 SVG 后自动打开。
- **`crispr.mjs` + `molbio_grna_design`**：SpCas9 约定的 PAM 锚定 gRNA 设计。双链扫描
  20 nt protospacer，逐条报告 1-based 顶链坐标、链向、GC%、NN Tm、Primer3 式
  self-any/self-end、种子自互补、发夹 Tm、poly-T，以及逐项公开的启发式评分
  （GC/Tm/poly-T/同聚/自互补/种子/发夹/**每个脱靶 8 分**/PAM 前一位 G +4）。
  硬过滤（GC 上下限、poly-T、3' 自互补、G/C 同聚）可调且报告被过滤条数；
  `check_off_target`（默认开）复用 v12 mispriming 的 k-mer 索引思路做**错配容差脱靶
  搜索**（仅替换、PAM 必须完好、种子末端 2 位不错配），默认只搜得分最高的 200 条候选。
  可选 `save_path`（订购 CSV）与 `map_path`（带 gRNA 标记的质粒图谱）。

### 修复（实现过程中发现并修掉的真实缺陷）

- **反向链 protospacer 长度错误**：初版把 `PAM + guideLength` 整段反向互补，产出的是
  23 nt 而不是 20 nt 的"guide"。已改为 PAM 下游的 20 nt，并在 smoke 里加了
  `sequence.length === 20` 与「顶链切片反向互补 = guide」两条不变式。
- **logo 字形溢出列宽**：初版用 `font-size = 高度/0.72`，2 bits 的列会算出 200+ px 的
  字号、横向压到邻列。改为「字号同时受列宽与图高约束 + `textLength` 压缩宽字形」，
  smoke 里逐字形断言 `font-size`/`textLength` 不超列宽。
- **脱靶计数把自己的靶点算成脱靶**：同一位置可能有多条变体拼写命中（guide 是其自身
  反向互补时更多），已改为按「位置 + 链向」在截断前排除并计数。

### 其它

- `logo.mjs` / `crispr.mjs` 进入 `files` 白名单；preset 组合的 `tool-molbio` 行与
  `preset.yml` 描述同步到 v16 / 46 个工具。

## [0.5.1] — 2026-09-10

**发布修复：preset 在 DSH 0.1.5-alpha.2 上无法挂载；新增 preset 健康检查。**

插件代码（`.mjs`）与 v0.5.0 完全一致，仍为 v15 版本目录——本次只改 preset 组合与文档，
因此**不需要新版本目录**（`plugins/dsh-molbio-tools-v15/` 逐字节未变）。

### 修复

- **`persona` 行在 DSH 0.1.5-alpha.2 上硬挂载失败**：组合里写的是
  `config: { text: ... }`，而当前 `@deepseek-ai/dsh-persona` 的 `Config` 要求
  `prefix`（`suffix` 可选）——校验报 `$.prefix missing required value`，整个
  Molecular Biology Lab 预设无法挂载，会话无法选择该模式。已按官方 `standard`
  预设改回 `prefix` + `suffix` 两段。
- **补回 `present` 行**：`@deepseek-ai/dsh-tool-present` 是官方非 `minimal` 预设都带的
  工具（显式声明工作区交付物）。此前与 `standard` 同步时漏掉了该行，导致 molbio 会话
  缺少 `present`——而本插件的主要产物（图谱/凝胶/曲线 SVG）正是要靠它声明交付。
  它只消费宿主侧 `fs`/`session`/`tools`，不发布服务，无需 realm。

### 新增

- **`test/preset-health.mjs`**：把 preset 组合里的**每一行** config 交给该包自己的
  `Config` schema 校验（与 Loader 挂载时同一套判定，但不启动 harness），并检查
  「行指向的模块是否存在」与「相对官方 `standard` 预设的行差异」。上面那个
  persona 故障正是它能捕获、而 `test/smoke.mjs` 结构上不可能捕获的一类问题——冒烟测试
  证明插件可用，证明不了组合可挂载。
  用法：`node test/preset-health.mjs [composition.yml] [--dsh <harness 根目录>]`。
- `package.json` 增加 `test` / `test:smoke` / `test:preset` 脚本；`files` 白名单纳入
  `preset/`、`test/`、`docs/`，npm 渠道也能拿到可直接复制的 preset 目录。

### 文档

- README：修正「全部 39 个工具」的过时表述（v10 时代遗留，现为 44），补充 preset 安装
  说明与健康检查入口。
- `docs/maintainer.md`：发布流程加入 preset 健康检查步骤；重新核对 DSH 0.1.5-alpha.2。

## [0.5.0] — 2026-08-22（preset 目录 v15）

**多序列比对与保守性分析。**

- 新增 `msa.mjs`：渐进式多序列比对——两两/谱-谱全局比对用**仿射缺口罚分**
  （match +4 / mismatch −4 / 缺口开 −6 / 延伸 −2）且**末端缺口免费**（半全局），
  合并顺序由 **5-mer 距离 + UPGMA** 引导树决定，谱-谱打分用和-对（sum-of-pairs）；
  合并时新缺口按"一旦有缺口、永远有缺口"整列延伸。输入 2-50 条、单条 ≤ 3000 bp、
  总长 ≤ 30000 bp；输出顺序与输入一致。
- 新增 `molbio_msa_align`：返回比对后序列与两两同一性统计，可 `save_path` 写出比对 FASTA。
- 新增 `molbio_conservation`：共识序列（最高频碱基 ≥50%，否则给出 IUPAC 简并码）、
  逐列 identity、熵基保守性（1 − H/2）、保守/可变列统计（`threshold` 默认 0.8）；
  输入可以是已比对序列（`alignment`）、原始序列或 FASTA，后两者自动先比对。
- 工具总数 42 → 44。

## [0.4.0] — 2026-08-20（preset 目录 v14）

**正确性修复 + 图片自动查看。**

- 修正线粒体密码子表中 `AGA`/`AGG` 的终止语义。
- Sanger 验证：氨基酸后果改为**密码子局部**判定，支持框内缺失。
- IIS 酶**反向位点**的顶链切点位置修正（Golden Gate 的 zPrime 连接因此正确）。
- 新增 `view.mjs`：所有生成图片的工具（质粒图谱、克隆/Golden Gate 的 `map_path`、
  标准曲线 `plot_path`、通用绘图、虚拟凝胶）写完 SVG 后用**操作系统默认应用自动打开**
  （Windows `Invoke-Item`、macOS `open`、桌面 Linux `xdg-open`/`$BROWSER`、WSL 转译路径）；
  逐调用 `auto_view: false` 可关，headless 与 `MOLBIO_AUTO_VIEW=0` 自动跳过，
  结果里 `auto_viewed` 回显交接结果。

## [0.3.0] — 2026-08-19（preset 目录 v13）

**反应条件、Golden Gate、酶目录、虚拟凝胶。**

- 两个引物设计工具新增盐/浓度旋钮 `na_mm`/`mg_mm`/`dntp_mm`/`primer_nm`
  （默认 50/1.5/0.8/200），驱动 Tm 的 von Ahsen 2001 盐校正与发夹/二聚体折叠浓度，
  输出 `conditions` 回显实际条件。
- 两个引物设计工具新增 3' 目标位置偏好 `target_position` + `target_penalty`
  （SNP 分型/定点设计），报告 `target_distance`。
- 新增 `molbio_enzyme_lookup`：90+ 酶目录查询；给定序列时报告**双链向**切点
  （IIS 酶的反向识别位点，`molbio_restriction_sites` 不报告）。
- 新增 `molbio_golden_gate`：IIS 酶多片段组装——自动设计唯一/非回文/非互补的 4 bp
  突出端，检查酶不切片段，生成可下单的 `fragments_to_order`，拼出最终质粒并平移特征；
  载体盒子位点保留在骨架（标准 destination 行为，下一级换酶）。
- 新增 `molbio_virtual_gel`：log₁₀ 迁移率模型的虚拟琼脂糖凝胶图 + 分子量 ladder。
- 新增 `molbio_enzyme_lookup` / `molbio_golden_gate` / `molbio_virtual_gel`，
  工具总数 39 → 42。

## [0.2.0] — 2026-08-18（preset 目录 v12）

**引物设计的 Primer3 对齐与错配容差。**

- 结构筛查改为 Primer3 同款热力学模型：自互补（self-any/self-end）比对分
  （match +1 / mismatch −1 / gap −0.25，阈值 8.0/3.0）、发夹与引物二聚体用同一套
  SantaLucia NN 参数折成 Tm（默认阈值 47 °C）、3' 端稳定性（末 5 碱基 ΔG(37 °C)）
  与末 5 碱基 GC 数、GC clamp 0-3 连续分级。
- 引物设计支持**错配容差**：`max_mismatches > 0` 时可用最少的替换挽救无解窗口
  （3' 末端碱基永不错配，默认保护 3' 端 5 bp 关键区），每处错配逐条报告并计入排序罚分；
  精确引物永远优先。跨内含子设计在 spliced/genomic 双坐标下报告错配。
- 新增非特异结合检查 `check_mispriming`：3' 尾在模板双链上的额外退火位点。

## [0.1.0] — 2026-08-16（preset 目录 v10/v11）

**首个公开发布：39 个 molbio 工具 + Molecular Biology Lab 预设渠道。**

- 序列分析、引物设计与检查（含跨内含子 qPCR）、酶切模拟、SnapGene `.dna` /
  GenBank 解析与 SVG 质粒图谱、克隆模拟（酶切-连接 / Gibson）、Sanger 验证、
  蛋白工具、qPCR 与绘图、文献库与协议/实验记录。
- 新增 **Molecular Biology Lab 专属模式 preset**：工具只在选择该模式的会话中出现，
  不污染其它场景；同时保留官方 bundle（`dsh plugin add`）渠道。
- 确立**版本目录规则**（每次更新新建 `dsh-molbio-tools-vN/`），因为 DSH 的 standing
  挂载按 ESM 文件 URL 缓存模块，原地改文件不会生效。
