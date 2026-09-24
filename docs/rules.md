# 硬规则（Rules）

本文是**不能违反的约束**——写代码、改 preset、发版本时照着做。
操作步骤（跑什么命令、按什么顺序）见 [workflow.md](workflow.md)。

每条规则后面都注明**它是怎么被换来的**：本仓库的规则几乎都是某次事故的账单，
忘掉出处就会有人重新"优化"掉它。

---

## 1. preset 行必须按**包名**引用（0.13.0 起，0.1.7-alpha.1 硬规则）

`preset/molbio-lab/agent.cordis.yml` 末尾那行必须写包名：

```yaml
- id: tool-molbio
  name: 'dsh-molbio-tools'          # ✅ Node 从 profile 的 node_modules 解析
```

**不要**写相对路径（`./plugins/dsh-molbio-tools-v20/index.mjs`）。0.1.6 及更早可以，
0.1.7-alpha.1 **不行**，而且失败方式极其隐蔽：

| 你看到的 | 实际情况 |
|---|---|
| 预设选择器里显示"加载失败" | preset **挂载成功**；只有 `agentPresets/list` 的 `broken` 字段有内容 |
| `--dump-config` 一切正常 | 组合树完全正确，问题在**运行时**，静态检查看不见 |
| 报错 `tool-molbio (…): never started` | 该 entry 被创建但**从未被 import**，`fiberPhase` 为 `null` |

**怎么验证**（必须真的起一次，静态检查不够）：建一个 scratch profile
（`dsh scratch --from-default-profile web --dump-config`，把依赖与 bundle 指向本包，
`pnpm install`），起 `dsh --profile scratch --no-open --port 3099` 并记下打印的 `?token=…`；
用 token 换 cookie 后查两个接口：

```powershell
curl.exe -s -c jar -o NUL "http://127.0.0.1:3099/?token=<token>"
curl.exe -s -b jar -X POST http://127.0.0.1:3099/api/agentPresets/list `
  -H "Content-Type: application/json" -H "Origin: http://127.0.0.1:3099" `
  -d '{"type":"client-request","rpcId":"p","method":"agentPresets/list","payload":{"args":{}}}'
# 同样方式查 pluginInventory/list，看 molbio-lab 行的 tool-molbio
```

判据是**两个字段**：`agentPresets/list` 的 `broken` 必须为空，且 `pluginInventory/list` 里
`molbio-lab` 的 `tool-molbio` 必须是 `fiberPhase: "active"`（不是 `null`）。
`/api/...` 的请求体必须带外层 envelope（`type`/`rpcId`/`method`/`payload.args`），
只发 `{}` 只会得到 `arguments-invalid`。验证完删掉 scratch profile。

`test/preset-health.mjs` 现在直接盯着这条规则：组合里出现任何 `./plugins/…` 形式的
specifier 就 FAIL，并已用突变实验证明它会失败。

---

## 2. preset 的 `order` 不得与上游撞号

`build/preset-patch.mjs` 里写死的 `order: 5` 是有意的：DSH 自带的 preset 占用
**standard=1、ptc=2、minimal=3、cordis=4**，而注册表按
`(a.order ?? Infinity) - (b.order ?? Infinity) || a.id.localeCompare(b.id)` 排序。

撞号的后果不是报错，而是**选择器里的顺序变成字母序的偶然**——0.13.0 曾写成 `order: 2`
（与 `ptc` 相同），实测 `molbio-lab` 被排到了**最后**。

`test/preset-health.mjs` 会把本包 preset 的 order 与
`<harness>/…/dsh-web-app/presets/*.patch.yml` 里每个上游 preset 的 order 对比，
**相同即 FAIL**（并已用突变实验验证会失败）。DSH 若新增 preset 占了 5，改成下一个空号即可。

---

## 3. 客户端座位一律 `ctx.slots.inject`，绝不裸 `register`

```js
ctx.effect(() => ctx.slots.inject(座位, () => ctx.slots.register({name: 座位, …}, 组件)), 标签)
```

座位只有在**拥有它的 entry 在自己的 `children` 表里声明之后**才存在
（`sidebar.right.pane.tab` ← 右栏 `rightbar.session`；`tool.call.toolview` ← ui-tool 的
`conversation.chat.node` 的**子座位**），而本包与那些包的 entry 之间没有顺序保证。

裸 `register` 抛出的
`slot "…" is not declared (a parent entry's children table must declare it)`
从 `apply()` 逃出就是**加载器 entry 失败**——HARNESS "Failed to load plugins"，
整个 Web GUI 不启动。

出处：0.7.2 用一次 GUI 起不来换来。`test/slots-stub.mjs`（SlotCore 语义的桩）与
`test/client.mjs`（从"零座位已声明"启动）在运行时看守这条纪律，
`test/contract.mjs` 第 10 项再看守"产物里每一处 `register` 都在 `inject` 里"。

---

## 4. 产物纪律（三条 + 一条发现规则）

1. **产物必须与源一起提交**——`dsh plugin add` 装的是产物，用户机器上没有构建步骤。
2. **发布白名单必须覆盖产物所在目录**（`lib/`、`packages/`）——`npm publish` 只带
   `files` 列出的东西，漏了就会出现"装完却没有面板"的静默失败，
   `test/contract.mjs` 的打包检查专门盯着这一条。
3. **产物不得进 preset 目录**——客户端模块靠 `rev` 哈希失效；0.13.0 起 preset 目录里
   本来也不再放任何东西了。
4. **每个 `dsh.client` 包必须有一个宿主平面的行能解析到它。** DSH 的客户端模块扫描只走
   **宿主 Loader 树**（`dsh-client-modules` 原话："scans the host Loader's entries"：它遍历
   `ctx.loader.entries()`，要求 `entry.fiber !== undefined`，然后读那一行的包 manifest 取
   `dsh.client` 与 `exports["./client"]`）。preset 的行挂在**隔离的子树**里，这个扫描永远看不到。

   > **0.15.2 的教训（两个侧边栏 tab 静默消失）**：把 57 个工具移进 molbio-lab preset
   > （这是对的——它们不该进每个会话）之后，本包**失去了唯一的宿主行**。产物是新的、里面
   > 两个 tab 的注册也都在、`client-mount` 的旧断言也全绿——**因为没有任何一条在问"这个包
   > 还能不能被扫到"**。结果：bundle 进不了 `window.__DSH_BOOT__`，右栏 Molbio/Papers
   > 两个 tab 从此不存在。
   >
   > 修法：`cordis.patch.yml` 插一行**惰性锚点** `- id: molbio-client / name: './host.mjs'`
   > （`host.mjs` 不注册工具、不发布服务，只提供可被扫描的行）。**不能用 `index.mjs` 当锚点**
   > ——那是工具插件，import 它就会把 57 个工具塞回每个会话。
   >
   > `test/client-mount.mjs` 现在按"包是否被该 profile 选中"逐包断言这件事：被选中却没有任何
   > 宿主行能解析到它 → FAIL 并指明修法。已用突变实验（把锚点行改回空列表）验证会失败。

   相关的另一半：客户端 bundle 的**依赖**（`dsh.client.inject`）必须自身也是 graph 行，
   否则产物里的 `require` 没有答案——同一条测试的 `missing` 断言守着。

---

## 5. 所有写入经 `ctx.fs`，并携带会话 `sandboxPolicy`

附加一条边界：**`font-metrics.mjs` / `svgio.mjs` / `svgpng.mjs` 不进客户端产物**
（`svgpng.mjs` import `node:zlib`，进 bundle 就会在浏览器里炸）。
`contract.mjs` 与 `test/svgpng.mjs` 各有一条断言盯着这件事。

与官方 `tool-fs` 模式一致；读取用 `readBytes` 带大小上限。

**不允许**为了绕开"二进制写不了"而直接 `node:fs` 写盘、或起子进程写盘——两者都逃出
"所有写入经 `ctx.fs` 并携带会话 sandboxPolicy"这条纪律。v18 因此**放弃**了
`png_path` 参数，改走附件通路（见 [history.md](history.md) 的 v18 段）。
`test/contract.mjs` 里有一条断言专门盯着"工作区仍不能存二进制文件"这件事——
哪天上游给 fs 缝加上二进制写入，那条断言会失败，那时才该回头补 `png_path`。

---

## 6. 功能变了就必须动 benchmark（没变就不必跑）

**新增或改动任何工具行为 → 必须新增/更新对应的 benchmark 任务并重跑；没有改动 → 不必重跑。**
判据是**任务观察到的输出会不会变**，完整的对照表与分档命令见
[workflow.md](workflow.md) 第 2 节。

这条规则有两道**机器守卫**，它们让"忘了"变成"红"：

- `test/benchmark-coverage.mjs` 断言 **57/57 个已注册工具都被至少一个任务覆盖**。
  新增工具而没加任务 = **直接 FAIL**。它同时守住 fixture 的前提（Golden Gate 的载体必须
  无 BsaI 位点、诱变模板必须仍能设计出引物）与 tier/占位符的健全性。
- `test/benchmark-score.mjs` 用**真实模型响应的冻结副本**（`test/fixtures/benchmark-traces.json`）
  回放判分器，并证明判分器**仍然会失败**。它拦住的是本仓库真的发生过的那类退化：
  六条断言在给**措辞**打分而不是给**内容**打分（字面量 `GAATTC` vs 模型写的切点记法
  `G^AATTC`、要求"2 bands"而模型正确地分开了理论片段数与可见条带数、要求字面 `?` 而
  headless 组合没有问答器……）。

配套的**零成本**门（在 `npm test` 里，任何改动都会跑）：`bench --offline` 把每条
`where: "tool"` 断言拿去和**工具真实渲染出来的文本**比对。**离线绿是离线跑模型的前提**——
期望值本身错了的话，跑出来的分数是在给 benchmark 自己打分。

---

## 7. 与官方插件规范的对照（以及三处已标注的偏差）

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
- **文件与沙箱**：所有写入经 `ctx.fs` 并携带会话 `sandboxPolicy`（见规则 5）；
- **组合规则**：插件不发布任何服务（无需 isolate realm）；随 preset 挂载且
  `standingKeyFor` 校验通过；
- **prompt 段**：`ctx.systemPrompt.section` 注册在 100–199 工具指导区段（order 110），
  与官方 `tool-bash` 同模式。

**已知的合理偏差（均已标注）**：未提供 schemastery `Config`（无配置项）；错误类型为
`MolbioInputError extends Error`（零依赖无法 import `HarnessError`，语义上等价于参数/
输入错误）；未实现可选的 `presentCall`/`presentResult`（内置 Web 客户端不消费它们，
卡片走 `presentationMeta`）。

---

## 8. 自动查看（auto-view）的平台边界

图片工具写完 SVG 后通过 `view.mjs` 直接调用操作系统默认应用打开（Windows
`Invoke-Item`、macOS `open`、桌面 Linux `xdg-open`/`$BROWSER`、WSL 经 `wslpath`
转译），镜像网关 `host.openPath` 的语义与 `canOpenNativePath` 的桌面可达性判定
（headless Linux 不 spawn）。

两条硬约束：`MOLBIO_AUTO_VIEW=0` 全局关闭（**所有测试与 benchmark 都必须设它**，
否则会真实弹窗）；opener 用可注入 `internals` seam 保持可测。工具层暴露
`auto_view`（默认 true，逐调用可关）并回显 `auto_viewed`。

---

## 9. 守卫必须被证明会失败

**"没人见过失败的守卫不算守卫。"** 新增或修改任何 drift / health / contract 检查时，
必须同时给出**能驱动它失败**的输入：`test/drift-probe.mjs` 就是为此存在的，
`preset-health` 的 order 检查、specifier 检查、`contract.mjs` 的"空白容忍"自检、
`test/benchmark-score.mjs` 的"判分器仍能失败"都各自带一个突变实验。

出处：0.1.6-alpha.1 的旧 drift 检查只比 id、对真故障只打印 note 并退出 0；
`contract.mjs` 曾把断言绑在 minifier 的空格上，放宽成"不绑格式"时如果没有自检，
下一次修改就会退化成"什么都不检查"。
