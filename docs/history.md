# 版本历史与教训（History）

本文是**已经发生的事**：每个版本交付了什么、当时踩了什么坑、留下了哪条规则。
可执行的版本记录在 [CHANGELOG.md](../CHANGELOG.md)；未来的方向见 [roadmap.md](roadmap.md)；
由这些事故换来的硬规则汇总在 [rules.md](rules.md)。

> **版本目录已删除（0.13.0）。** `preset/molbio-lab/plugins/dsh-molbio-tools-vN/` 整体不复存在。
> 那套机制是为规避**相对文件 URL** 的 ESM 模块缓存：preset 行写相对路径，于是每次发版都要把
> 全部 `.mjs` 复制进一个**新目录**（删除前累计 195 个文件 / 5.2 MB）。preset 行改用**包名**后，
> 缓存问题与拷贝都不存在了，`preset-health.mjs` 的**镜像检查**也一并删除。
> 下文提到 `vN` 目录的地方是**当时的记录**，不再是纪律。

---

## 版本一览

| 包版本 | preset 版本 | 内容 | 工具数 |
| --- | --- | --- | --- |
| 0.14.0 | — | 文档重构（rules/workflow/roadmap/history）+ 首个可用性 benchmark；插件行为零变化 | 57 |
| 0.13.1 | — | 在 DSH 0.1.7-alpha.2 上验证通过；修 preset order 撞号 | 57 |
| 0.13.0 | — | 适配 DSH 0.1.7-alpha.1（面板文件读取失效、preset 进 bundle）；删除版本目录 | 57 |
| 0.12.0 | v20 | 比对残基守恒 + `<tspan>` 多行文本；新增 `font-metrics.mjs` | 57 |
| 0.11.0 | v19 | 实验台分析五件套 + `svgio.mjs` | 52 → 57 |
| 0.10.0 | v18 | `svgpng.mjs`（画出来的图交给模型看）+ 11 个画图工具的 `attach_image` | 52 |
| 0.9.1 | — | 修 DSH 0.1.6-alpha.1 的 preset 组合（preset 挂不上） | 52 |
| 0.9.0 | v17 | TaqMan 探针、多重 PCR 互扰、甲基化/双酶切、蛋白图 | 46 → 52 |
| 0.8.0 | v17 | route-B preset 安装（把包内 preset 注册进 profile） | 46 |
| 0.7.2 | — | 修座位抢注竞态（它让 Web GUI 起不来） | 46 |
| 0.7.1 | — | 图谱工具在会话里画图（`tool.call.toolview`） | 46 |
| 0.7.0 | — | 发布浏览器面板 | 46 |
| 0.6.0 | v16 | Sequence logo + CRISPR gRNA 设计 | 44 → 46 |
| 0.5.0 | v15 | 多序列比对（渐进仿射缺口 NW + UPGMA）与保守性分析 | — |
| — | v12–v14 | Primer3 对齐与错配容差；盐/浓度旋钮、Golden Gate、酶目录、虚拟凝胶；线粒体密码子与 Sanger/酶切几何修正 + auto-view | — |

---

## v0.14.0（2026-09-23，包 0.14.0）

**不新增也不修改任何工具**——这一版改的是"这个项目怎么维护"与"它第一次能被测量"。
完整条目见 [CHANGELOG 0.14.0](../CHANGELOG.md)；这里只留三条方法论教训。

**(1) 一个 benchmark 的第一版，很可能在测它自己。** 第一次完整运行是 **0/15**，而**没有一条
失败是插件的错**。根因是 `spawn(..., { shell: true })` 在 Windows 上**拼接** argv 而不转义，
多行任务被截成**第一个词**——模型收到的是 `Save` 不是整条指令。唯一症状是模型说"序列不在
对话里"，而"工具选错"这个解释同样说得通。**教训**：花一次调用做**送达 preflight**
（探针 token 不回显就拒绝运行），比花十五次调用去猜便宜得多。

**(2) 离线门和实跑必须消费同一份文本。** `where: "tool"` 断言最初在离线侧比对工具的
**原始 JSON**，而运行时 trace **只带渲染文本**——于是离线永远绿、实跑永远红。
离线校验一个运行时不存在的格式，比没有校验更糟：它给了一个**假的安全感**。

**(3) 断言容易悄悄退化成"给措辞打分"。** 这一轮修掉六条：字面量 `GAATTC`（模型写切点记法
`G^AATTC`）、要求"2 bands"（模型正确区分了理论片段数与板上实际可见条带数）、要求字面 `?`
（headless 没有问答器，模型被要求在散文里提问）、把 `seq1/seq2` 参数顺序钉死
（`molbio_align` 的同一性是**对称的**）等。**判据是**：这条断言失败时，提供的信息是关于
**内容**还是关于**排版**？关于排版的一律放宽，但**必须同时留一条"证明判分器还能失败"的
自检**（`test/benchmark-score.mjs`），否则放宽的下一步就是"什么都不检查"——
与 0.1.6-alpha.2 那次 `contract.mjs` 的空白容忍是同一个陷阱。

顺带清掉了仓库里写死的用户路径：`test/smoke.mjs` 与 `test/map-card.mjs` 曾以
`file:///C:/Users/18771/AppData/...` 硬导入 harness 的 `dsh-tools`，**这套测试只可能在一台
机器上通过**，而且在别的机器上它会**静默导入另一个 harness**（与 `preset-health` 校验的
不是同一个）。现在 harness 定位只有一处实现（`benchmark/harness.mjs`），五个套件共用。

---

## v20（2026-09-18，包 0.12.0）

**两条"沉默的错"**——不报错，但结果是错的：

**(A) `msa.mjs` 渐进比对丢掉尾部悬垂残基。** 11 bp 对 10 bp 只留 10 列，长的那条被静默
截断。根因不是"忘了补"，而是**补错了位置**：半全局（末端缺口免费）的 DP 允许最优路径在
任一序列末尾之前停下，而补缺口的两个循环只覆盖了路径**起点之前**（前导悬垂），端点**之后**
的残基从来没有代码把它发出来。

- 修法：把端点之后的残基作为纯悬垂列追加。三个必须写对的细节：①**单独收集**——`opA`/`opB`
  在 `reverse()` 之前是反序的，把正序 suffix 直接 push 进去再整体 reverse 会把残基挪到开头
  （第一版实测输出 `GACGTACGTAC`，末位碱基跑到首位）；②`bi`/`bj` 是"路径已消耗的长度"，
  所以区间是 `[bi, la)`；③`score` 不动（悬垂列计 0 分）。
- **不变式**：每条输出行去掉 `-` 后**逐字符等于它的输入序列**，且所有行等长。
  测试直接断言这个不变式，而不是断言某个列数。
- `coverageShortfall` 抽到 `phylo.mjs` 并导出：v19 的 WARNING 现在不该再对真实输出触发，
  但守卫留着，并**用一个故意截断的行驱动它**断言仍会报警——否则"没有警告"什么也证明不了。

**(D) `svgpng.mjs` 的 `<tspan>` 多行文本。** 矩形树图里长叶名被画成一行、直接压到相邻标签上；
v19 的光栅化器把 `<text>` 里的任何嵌套标签当作"这一段文本结束"，`<tspan>` 因此落进
`unsupported`，**同一段文字被画两遍**。

- 分三层修：光栅化器支持 `<tspan>`（`x`/`y` 绝对定位与 `dx`/`dy` 相对偏移都支持，空的自闭合
  `<tspan dy/>` 推进一个空行；带 `transform` 或嵌套 `<tspan>` 一律**计入 unsupported 并上报**，
  绝不猜一个位置画出来）；字宽度量抽成 `font-metrics.mjs`（**排版预留与光栅化绘制必须是同一个
  数**，复制一份常量会静默漂移，症状只是"标签压到邻居上"）；折行助手进 `svgio.mjs`
  （`wrapTextLines`/`textSpanLines`，长标识符在分隔符之后断行，无分隔符时按字数硬断，
  **绝不溢出预算**，折行无损）。
- **图像回归守卫**：在标签列里统计"密集行"，断言每个长名字至少两行、4 个标签块之间**至少 3 处
  空白间隔**。v19 的单行长标签会把这个数字压到 0 或 1——所以这条断言**真的会因为那个 bug 而
  失败**。扫描区间从文档里**读出**（第一个 `<tspan>` 的 `x`），因为靠猜会把分支尖端、支持度
  和标题都算成"标签行"（第一版数出 9~10 条带）。
- **环形与扇形布局不折行**：旋转文本没有按真实字宽测量，硬折会算错行数（见
  [roadmap.md](roadmap.md) 2.3）。

**顺带修掉 `preset.yml` 的工具数停在 52**（v19 从 52 加到 57 时漏改，用户在整个 v19 周期看到的
是错的数字，且没有任何检查会发现）→ 补守卫 `toolCountDrift`。

**实现时才暴露的偏差**（计划里没有的）：A 的第一版按"补前导悬垂"写，实测**完全没生效**
（traceback 的 while 已经耗尽前导悬垂，两个分支是死代码，真正丢的是**尾部**）；D 的折行第一版
有两处 bug（长标识符里的 `_` 让每个 `_` 之间被当成一个"词"；整段就是一个长 token 时会丢掉第一
段）；D 的解析器漏了推进 `contentStart`，`</tspan>` 之后从标签**内部**切片，把字面量
`"</tspan>"` 当文本画出来——**这个 bug 是看图发现的**，正是 v18 建立的那条人眼复核链路。

---

## v19（2026-09-18，包 0.11.0）

实验台分析五件套（`molbio_fastq_qc`、`molbio_codon_usage`、`molbio_phylogenetic_tree`、
`molbio_pcr_simulate`、`molbio_gc_composition`）+ 共享绘图助手 `svgio.mjs` + 套件
`test/svgio.mjs`。工具 52 → 57，`attach_image` 11 → 15。

同时在 DSH 0.1.6-alpha.2 上报出两处漂移，**性质完全不同**：

1. **preset 少了上游新增的 `tool-plugin-manager` 行** → 组合与 `standard` 不再逐行一致。
   这是**组合层**的漂移，被逐行结构比对正确拦下。
2. **`test/contract.mjs` 绑定了 minifier 的空格**（`ctx.slots.provideRoot({ hooks: {` 这一
   **单空格**拼写），alpha.2 把同一调用排成四行缩进。**契约没变**，所以这是断言绑格式、
   不是产品故障。改成空白容忍，并**加了一条不空转自检**：四种拼写都必须通过，把 `hooks`
   改名成 `hookz` 必须失败。**这条自检是关键**——否则"放宽成不绑格式"的下一次修改就会退化成
   "什么都不检查"。

还把"比对器可能丢残基"从静默风险改为显式 WARNING（真正的修复留到 v20）。

---

## v18（2026-09-17，包 0.10.0）

**把画出来的图交给模型看。** `svgpng.mjs`（零依赖 SVG 子集光栅化 + 自写 PNG 编码
IHDR/IDAT/IEND + 自算 CRC32，deflate 用内置 `node:zlib`；内置**折线字体**覆盖 ASCII 与
`· ° ± — – … ≈ μ α ─`）+ 11 个画图工具的可选 `attach_image`。

**为什么是附件而不是文件**（三层证据）：`dsh-fs/README.md` 写明 *Text-only mutations by
contract — binary-safe mutations remain deferred*；`dsh-fs-local` 的 `writeText → writeFileAtomic`
把字符串按 UTF-8 落盘，读取以 `subarray(0, 8192).includes(0)` 拒收 NUL，**连读回都做不到**；
全树检索**没有任何 `writeBytes`**。绕开它有两条路（直接 `node:fs`、起子进程写盘），两者都
逃出"所有写入经 `ctx.fs`"的纪律。而 `ctx.attachments.saveImage({ data, mediaType })` 是
harness 提供的**二进制安全**通路，工具结果的 `output.render` 可以返回 image content block
——这正是 `read_image` 自己用的那条路。

三条实现纪律：**能力门照抄 harness 的规则**（`requestHeader().config` → provider/model →
`resolveModelInfo()` → `inputModalities.includes('image')`，与 `read_image` 同源，`contract.mjs`
盯着它）；**永不失败**（图片是额外好处：无附件服务/文本路由/渲染不了/存储拒收都降级为纯文本
+ `image_note` 说明原因，SVG 照写、调用照成功）；**渲染不了的要上报**
（`unsupported`/`missing_glyphs` 计数，测试断言真实渲染器的产物必须落在支持子集内）。

顺带修掉一个真 bug：**线性质粒图谱的根 viewBox 固定 `0 0 840 840`**，而 `renderLinear`
画到 x≈900——3' 端一直被裁掉（浏览器里同样裁）。现在按拓扑选画布（960×260 / 840×840）。
**是"给模型看图"这件事把这个 bug 暴露出来的。**

验证方式：像素用**独立实现**的 CRC + 裸 inflate 解回后手算断言；八份真实产物再经 harness
自己的图像解码器（`read_image`）**逐张人眼复核**——本项目第一次能"看着自己的产物"验证。

**"没验证到"的那一环（诚实清单）**：已证明的是附件服务能收下我们自己编码的 PNG
（`contract.mjs` 直接调 harness 的 `validateImageFile`/`prepareImageFile`，同一套生产解码/
归一化代码，并且**故意损坏的 PNG 会被拒**）。**尚未在真实会话里验证的**只有一步：本插件的
工具结果数组被 harness 的工具层接收并落进会话事件。验证方法：在 "Molecular Biology Lab"
模式里对 `molbio_virtual_gel(lanes=[...], attach_image=true)` 提一次，然后看会话事件里是否
出现 `{ type: 'image' }` 块、`image.attachment_id` 与附件目录里的对象是否对得上。

### v18 候选 3：持久 shell 进 preset（勘察结论：不进）

要加的行：`@deepseek-ai/dsh-terminal` + `dsh-terminal-bash` + `dsh-tool-pwsh-persistent`
（Linux 用 `dsh-tool-bash-persistent`）。`sandbox`/`sandbox-policy`/`subprocess` **已在
`dsh-base`**。两个硬约束：①**工具名冲突**——`dsh-tool-pwsh` 与 `dsh-tool-pwsh-persistent`
都注册 `pwsh`，必须把一次性那行 `disabled`，这会让我们偏离上游 `standard` 的逐行对齐；
②**唯一待验证点**——从 preset（不是 profile）发布服务需要一个 `isolate: { terminals: true }`
分组，机制在 shipped preset 里有先例（`planning`/`compaction`/`delegation`），但**没有任何
shipped preset 这样挂过 terminal**。收益（cwd/环境变量/conda/`samtools faidx` 索引跨调用存活）
抵不上这两条风险，故不做。

另外记录一条对实验台的实测边界：**Windows 上交互式 REPL 不可靠**（stdin 等待判定是启发式，
会跑到 300 s 工具超时并**重置 shell**），可靠写法是 `python -c` / `Rscript -e` 单行；
`ctx.terminals` 只能被**创建它的那个 agent** 操作（`FOREIGN_SESSION`），所以本包的插件工具
没有"替用户开终端标签页"的通路。

---

## v17（2026-09-13，包 0.9.0）

TaqMan 水解探针设计（`taqman.mjs` + `molbio_design_taqman`）、多重 PCR 互扰检查
（`multiplex.mjs` + `molbio_multiplex_check`）、甲基化敏感位点检查与双酶切 buffer 兼容
（`methylation.mjs` + `molbio_methylation_check` / `molbio_double_digest`，参考表进 `lib.mjs`）、
螺旋轮与疏水性图（`protein-structure.mjs` + `molbio_helical_wheel` / `molbio_hydropathy_plot`）。
工具 46 → 52。实现过程中三次纠正探针几何、抓到 `primer_options` 全表静默失效与两处
非 lossless-JSON 字段。

---

## v16（2026-09-10，包 0.6.0）

Sequence logo SVG（`logo.mjs` + `molbio_sequence_logo`，信息量 scaling 含小样本校正）+
CRISPR gRNA 设计（`crispr.mjs` + `molbio_grna_design`，双链 PAM 扫描、逐项公开的排序启发式、
复用 v12 mispriming 的 k-mer 索引做错配容差脱靶搜索）。工具 44 → 46。

---

## DSH 0.1.6 新能力的可用性勘察（2026-09-16，只读；基线 0.1.6-alpha.1）

用户侧报告 0.1.6 带来"面板内终端"与"computer use"。逐包核对（README + `lib/types/*.d.ts` +
shipped bundle 的 `cordis.patch.yml` + 活动 profile 的 patch）后的结论：

| 能力 | 本版实际状态 | 对 molbio 的可复用性 |
| --- | --- | --- |
| 面板内终端（`dsh-api-terminal-controller` + `dsh-client-ui-sidebar-terminal`） | **随 `dsh-web-app` 出厂即启用** | ✅ **已经在用，零改动** |
| 持久 shell（`ctx.terminals` + `dsh-terminal-bash` + `dsh-tool-*-persistent`） | 包已安装，**未被任何 web/standard 组合挂载** | ⚠️ 需要组合改动（结论：不做，见 v18 候选 3） |
| Computer Use / Browser Use | **本版没有实现**：只有 `dsh-tool-cordis` 生成目录里的 `ctx.computerUse`/`ctx.browserUse` 接口描述、`dsh-system-prompt` 里无人消费的 `TOOL_COMPUTER_USE: 3000`、以及 `dsh-mcp-client` README 提到的未安装 "Cua Driver provider" | ❌ 不进预设 |

**面板内终端与 molbio 面板已经共存，无需任何改动。** 两套东西同名不同源：浏览器终端是
**会话级、用户专用**的 Typert remote（`remote.terminal`，上限 8 个终端、scrollback 1000 行，
**终端输出永不进入 agent 上下文**）；`ctx.terminals` 是**按 agent 做 owner 隔离**的持久 PTY。
共存靠公开的 tab 注册 API：终端 `id = '@deepseek-ai/dsh-client-ui-sidebar-terminal'`、
`kind: 'terminal'`、guide order 20；本包 `id = 'dsh-molbio-tools'` / `'dsh-molbio-tools/papers'`、
guide order 40/41。**tab `id` 重复会抛异常**（本包那两个 id 的唯一性由 `test/client.mjs` 看守），
因此不要改自己的 id。

**MCP 与 hooks**（同批勘察）：`dsh-mcp-client` **未被任何 shipped bundle 挂载**（只有
`dsh-mcp-resources` 在 `dsh-base`），用户要加需在 profile 的 `cordis.patch.yml` 写一行。
**安全要点**：stdio MCP server 由 MCP SDK 自己 spawn，**不受 DSH 文件沙箱约束**，只做环境变量
清理（`/KEY|PASSWORD|SECRET|TOKEN/i` 与 `DSH_*` 被丢弃）。`dsh-hooks-*` 是给已有 Claude Code /
Codex `hooks.json` 的**兼容适配器**，不是插件扩展点——插件应直接监听
`tools/pre-execute` / `tools/post-execute` / `agent/pre-step` / `agent/turning-stopping`
这些同名拦截点。

---

## 更早的事故与教训

- **0.1.2 → 0.1.5**：遗漏 `persona` 的 `text → prefix/suffix` 契约变更，组合在 0.1.5-alpha.2 上
  直接挂载失败；`present` 行也在同一时期丢失。
- **0.1.6-alpha.1**：组合里的 `workflow-worker-thread` 指向**没有 DSH 发布过的包**，preset
  完全挂不上；同时 `tool-ralph` 被**悄悄启用**。两者都被旧版"只比 id"的 drift 检查放过
  （只打印 note、退出 0）。现已由**逐行结构比对（失败即阻断）** + `drift-probe.mjs` 看守。
- **0.7.1 → 0.7.2**：裸 `slots.register` 让 Web GUI 完全起不来（HARNESS "Failed to load
  plugins"）。教训写成规则：客户端座位一律 `ctx.slots.inject`。
- **0.13.0**：preset `order` 写成 `2`（与 `ptc` 相同），注册表按 `(order, id)` 排序，
  实测 `molbio-lab` 被排到**最后**。教训写成规则：order 不得与上游撞号。
- **0.9.1**：DSH 0.1.6-alpha.1 的 preset 组合变更（preset 挂不上）。
- **v20 实测的 npm 发布两个坑**（交互式 2FA 与 `pnpm` 缓存写权限）见
  [workflow.md](workflow.md) 第 3 节。
