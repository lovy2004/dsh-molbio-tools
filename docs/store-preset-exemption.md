# 技术说明：为什么本包的 bundle patch 必须声明官方 preset 行

**提交对象**：DSH STORE 维护者（预检 `SUBMISSION_PATCH_PROTECTED` / `SUBMISSION_PATCH_IDENTITY` /
`SUBMISSION_BUNDLE_PATCH_INVALID` 的判定）
**仓库**：<https://github.com/lovy2004/dsh-molbio-tools>
**结论**：本包不是「冒用 `@deepseek-ai/*`」。我们用的是 DSH 官方发行物里**唯一存在**的 preset 声明方式；
当前预检把这一行、以及它 `config.plugins` 里的官方配置行，一并按「冒用官方命名空间」拦截。
请求对这类 preset 容器行按「使用官方组件」而非「替换/冒用」处理，或改走人工专项审阅。

---

## 摘要（English）

The bundle does not impersonate `@deepseek-ai/*`. It declares an Agent preset using the only
form DSH supports — a row named `@deepseek-ai/dsh-agent-preset` — exactly as the first-party
`@deepseek-ai/dsh-web-app@0.2.1-rc.2` package does in `presets/standard.patch.yml`. The precheck
rejects that row twice: a raw-text regex flags any `name: '@deepseek-ai/...'` line (1 container
row + 29 config rows in our patch), and an identity rule requires every inserted row to resolve
to the submitted package. The same package also declares `dsh.bundle.patch` as an ordered list,
which DSH's runtime explicitly supports and the official web-app itself uses (5 files). We ask
for a parsed-contract exception for the preset container (and for string-or-array patch lists),
or a fixed-source manual review.

---

## 1. 这个包提交了什么

`package.json`（固定 commit，节选）：

```jsonc
"dsh": {
  "compatibility": {
    "dshReleases": {
      "0.2.1-rc.1": "unknown",
      "0.2.1-rc.2": "compatible",
      "0.2.1-rc.3": "unknown"
    }
  },
  "bundle": {
    "patch": "./cordis.patch.yml"
  },
  "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-sidebar-right", "@deepseek-ai/dsh-client-connection"] }
}
```

同一个 patch 文件里的两个 insert（顺序即应用顺序），分工固定：

```yaml
# cordis.patch.yml —— insert #1：唯一的宿主行，浏览器半的锚点，不注册任何工具
- insert:
    - id: molbio-client
      name: './host.mjs'
```

```yaml
# cordis.patch.yml —— insert #2：由 agent.cordis.yml 生成
- insert:
    - id: preset-molbio-lab
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: molbio-lab
        order: 5
        name: Molecular Biology Lab
        description: ...
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
          # ... 与官方 standard preset 同构的行清单 ...
          - id: tool-molbio
            name: dsh-molbio-tools     # 唯一自有的行
```

本包新增的 ID 全部是自有的：`molbio-client`、`preset-molbio-lab`、preset id `molbio-lab`、
工具行 `tool-molbio`。没有禁用、替换、遮蔽任何官方 entry，也没有发布或改名任何官方包。

## 2. 事实一：preset 在 DSH 里只有这一种写法

官方发行包 `@deepseek-ai/dsh-web-app@0.2.1-rc.2` 里，四个 shipped preset 都是同样的行：

```yaml
# node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml
# Agent preset standard: one `@deepseek-ai/dsh-agent-preset` declaration inserted
# after the web patch. ...
- insert:
    - id: preset-standard
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: standard
        order: 1
        plugins: [ ... ]
```

同一目录下的 `ptc.patch.yml`、`minimal.patch.yml`、`cordis.patch.yml` 第 6 行也都是
`name: '@deepseek-ai/dsh-agent-preset'`（可 `npm pack @deepseek-ai/dsh-web-app@0.2.1-rc.2` 后核对）。

官方 `cordis.patch.yml` 的注释把机制说得更直接：

> The preset selection registry. The shipped preset declarations follow as **separate patch files
> under `presets/`**, listed after this file in `package.json` `dsh.bundle.patch`.

也就是说：preset = 一行 `@deepseek-ai/dsh-agent-preset` + 一个 bundle patch 文件。
第三方插件要提供 preset，**没有第二种写法**——`id + config` 是覆盖已有行，YAML 别名/锚点会被
有界解析器拒绝，官方语义也不支持。

本包 `cordis.patch.yml` 的 preset 段正是把官方 `standard` preset 的 `config.plugins` 原样复制、末尾追加一行
`tool-molbio`，再用 `build/preset-patch.mjs` 从 `agent.cordis.yml` 生成（因此与上游行清单可逐行对照）。

## 3. 事实二：`dsh.bundle.patch` 官方就是有序数组

官方 `@deepseek-ai/dsh-web-app` 自己的清单：

```json
"dsh": { "bundle": { "patch": [
  "./cordis.patch.yml",
  "./presets/standard.patch.yml",
  "./presets/ptc.patch.yml",
  "./presets/minimal.patch.yml",
  "./presets/cordis.patch.yml"
] } }
```

DSH 运行时（`@deepseek-ai/dsh-app-boot` 的 `bundlePatchPaths`）明确接受两种形态：

```js
// dsh.bundle.patch: "one file, or an ordered list of files"
const declared = typeof bundle.patch === "string" ? [bundle.patch] : bundle.patch;
if (!Array.isArray(declared) || !declared.every((file) => typeof file === "string"))
  throw new Error("dsh.bundle.patch must be a file path or a list of file paths");
```

所以当前预检的「只接受字符串」比 DSH 自身的清单契约更严，且与官方包的实际写法相反。

## 4. 预检在哪三处拦住了本包

`scripts/check-plugin-submission.mjs`（DSH-Store `main`）：

| 规则 | 代码 | 本包触发原因 | 现状 |
| --- | --- | --- | --- |
| 单字符串 | `safePatchPath`: `typeof declared !== 'string'` → `SUBMISSION_BUNDLE_PATCH_INVALID` | 旧提交里两层 patch 用了数组 | **已自行解决**：本次提交已合并为单个 `cordis.patch.yml`（DSH 运行时对数组的支持见 §3，仍建议预检对齐） |
| 保护命名空间 | `patchEntryIds`: `/\bname:\s*['"]?@deepseek-ai\//i.test(patch)` → `SUBMISSION_PATCH_PROTECTED` | 1 行 preset 容器 + **29 行** `config.plugins` 里的官方行（原始文本正则，两者都命中） | **不能改**：删掉 preset 行就等于删掉 preset 功能 |
| 身份一致 | `checkRepository`: `contract.insertedEntries.some(row => row.packageName !== manifest.name)` → `SUBMISSION_PATCH_IDENTITY` | 锚点是相对路径 `./host.mjs`（解析出的包名是 `.`，被拒）；preset 行指向官方包 | **锚点不能改成子路径**（会让面板消失，见下）；preset 行不能改 |

### 为什么锚点不能简单改成「包名/子路径」

看起来 `name: './host.mjs'` 可以改成 `name: 'dsh-molbio-tools/host'` 来满足身份规则——**不行**。
DSH 的客户端模块扫描（`@deepseek-ai/dsh-client-modules`）只接受两类说明符：

```js
function exactPackageSpecifier(specifier) {
  if (specifier.startsWith("@")) { ... }               // 只接受 @scope/name 两段
  return specifier.length > 0 && !specifier.includes("/") && !specifier.includes(":")
    ? specifier : void 0;                              // 裸包名才接受
}
// locatePkgJson: 非路径型且取不到包名 → return void 0 → 该行永远不被扫描
```

也就是说 `dsh-molbio-tools/host` 这种子路径**不是**该扫描器认可的说明符，`locatePkgJson` 直接返回
`undefined`，浏览器半不会被发现，右栏 Molbio/Papers 两个 tab 会**静默消失**——正是当初引入锚点要
避免的故障。路径型（`./`、`file:`、绝对路径）是唯一既能挂一个惰性锚点、又能被扫描器解析的写法，
而它恰好被身份规则拒绝。

改成「包根本身」也不行：根模块是 `index.mjs`，一旦作为宿主行挂载就会把 60 个工具注册进该 profile
的每个会话——这是本包刻意避免的。

关键点：**这条正则扫的是 patch 原始文本**，所以它无法区分

- 真正的替换/冒用（`- id: 某官方 ID` / `name: '@deepseek-ai/某官方包'` 作为被插入的实现）；
- preset 容器行（唯一合法写法）；
- `config.plugins` 里的官方行（配置值，不是入口；官方 standard preset 本身就是这么写的）。

本包 `cordis.patch.yml` 的 preset 段里有 30 行 `name: '@deepseek-ai/...'`，其中 29 行属于第三类。

## 5. 这不是「冒用」，与收录标准的意图不冲突

商城标准 MKT007 要禁止的是：修改 DSH 核心、停用/替换/遮蔽官方清单或受保护组件。对照本包：

- 没有发布任何 `@deepseek-ai/*` 包，也没有修改任何官方文件；
- 没有插入官方 entry ID（我们的 entry 只有 `molbio-client`、`preset-molbio-lab`）；
- 没有 `disabled: true`、没有覆盖官方行的 `config`；
- preset 容器是**使用**官方 `@deepseek-ai/dsh-agent-preset` 插件来承载**自有** preset（id `molbio-lab`），
  与官方 web-app 承载 `standard` / `ptc` / `minimal` / `cordis` 的方式完全一致；
- 声明了 `engines.dsh` 与逐版本 `dshReleases`，无生命周期脚本，零运行依赖，MIT。

换句话说：这一行证明的是「我们用了官方 preset 机制」，不是「我们冒充了官方插件」。

## 6. 影响面不止本包

- 所有需要随包提供 Agent preset 的第三方插件，都会被同一正则拦下（DSH 没有别的声明方式）；
- 所有采用「一个 bundle + 多个 patch 文件」的第三方插件（官方 web-app 就是 5 个文件）会被
  单字符串规则拦下；
- 由于正则扫原始文本，即使放宽容器行，任何复制官方 preset 行清单的插件仍会被 `config.plugins`
  里的官方行命中。

## 7. 请求（按优先级）

1. **`dsh.bundle.patch` 接受字符串或字符串数组**，与 DSH 运行时契约一致（改动很小：
   `Array.isArray(declared)` 后逐项做 `safePatchPath`）。本包已改用单文件，因此这不是本包的
   阻断项；但官方 `dsh-web-app` 就是 5 个文件的列表，规则与运行时契约不一致会挡住同类第三方包。
2. **保护命名空间改按已解析的 `insertedEntries` 判定**，并给 preset 容器一个明确白名单：
   - 顶层 `insert` 的 `name` 指向官方 `@deepseek-ai/*` 包 → 仍然拦截（真正的冒用）；
   - 例外：`name === '@deepseek-ai/dsh-agent-preset'` **且** `config.id` 是本插件自有 id、
     入口 id `preset-*` 未被其他条目占用 → 视为 preset 声明；
   - `config.plugins` 视为配置值，不作为入口（与标准里「嵌套 config 内的 ID 不成为入口」一致）；
   - 仍然禁止 `disabled`、禁止覆盖官方 entry id、禁止把官方包名作为被插入的实现。
3. **允许 `./` 开头的自引用宿主行**（惰性锚点）：解析基准是 manifest 所在包目录，
   解析结果必须留在该包内、文件必须已分发。理由见 §4——子路径说明符不被客户端扫描器接受，
   包根又会把工具注册进每个会话，相对路径是既满足「可发现」又满足「不注册工具」的唯一写法。
   这条可以只对「`name` 以 `./` 开头、且 join 后仍在被审包目录内」的 insert 行放行。
4. 若暂不改预检代码：请给这类包一个**人工专项审阅**出口，把本固定 commit 送入
   `fixed-source review`，按实际内容判定，而不是按原始文本正则拒绝。

## 8. 我们愿意配合的

- 两层已合并成单个 `cordis.patch.yml`（锚点 + preset 同文件），生成器 `build/preset-patch.mjs`
  直接产出该文件；`--check` 保证它不漂移。若商城需要别的布局，改动只在该脚本与 manifest。
- 如果身份规则必须保留：我们评估过两种重构——(a) 包根改为惰性锚点、工具移到 `./tools` 子路径；
  (b) 锚点挂载根模块并在 `config` 里标记惰性。两者都改变包的入口语义，或让每次启动都加载整套
  工具模块，属于结构性变更；商城若倾向其中一种，我们可以按评审意见实施。
- 一次性 Profile 证据：`docs/store-evidence.md`（DSH 0.2.1-rc.2，tarball 安装 → 启动 HTTP 200 →
  卸载后组合树无残留）。
- 可提供任一指定 commit 的完整入口 ID 清单、setuid/网络/凭据能力说明、或额外材料。

## 9. 供复核的路径

| 证据 | 位置 |
| --- | --- |
| 官方 preset 行 | `@deepseek-ai/dsh-web-app@0.2.1-rc.2` → `presets/standard.patch.yml` 第 6 行（ptc/minimal/cordis 同） |
| 官方 patch 数组 | 同一包的 `package.json` → `dsh.bundle.patch`（5 个文件） |
| 运行时接受数组 | `@deepseek-ai/dsh-app-boot` → `bundlePatchPaths`（"one file, or an ordered list of files"） |
| 预检三条规则 | `AI-Scarlett/DSH-Store` → `scripts/check-plugin-submission.mjs`（`safePatchPath`、`patchEntryIds`、`checkRepository`） |
| 本包 patch | `cordis.patch.yml`（单文件、两个 insert；preset 段由 `agent.cordis.yml` 生成） |
