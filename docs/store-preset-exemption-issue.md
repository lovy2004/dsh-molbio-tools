# 短版（可直接贴到 DSH STORE 的 issue）

> 完整说明：[docs/store-preset-exemption.md](store-preset-exemption.md)

---

### 技术说明：本 bundle 声明的是官方 Agent preset，不是冒用 `@deepseek-ai/*`

本次提交已把 bundle patch 合并为单个 `cordis.patch.yml`，`SUBMISSION_BUNDLE_PATCH_INVALID`
（`patch` 只接受字符串）已自行解决。剩下两处需要判定：

**1. 保护命名空间正则命中的是 preset 容器行，不是替换**

预检 `patchEntryIds` 用 `/\bname:\s*['"]?@deepseek-ai\//i` 扫 patch 的**原始文本**。本包 patch 有
30 行命中：

- 1 行是 preset 容器：`- id: preset-molbio-lab` / `name: '@deepseek-ai/dsh-agent-preset'`；
- 29 行在它的 `config.plugins` 里，是官方 `standard` preset 的原样复制——那是**配置值**，不是插入的入口。

DSH 里 preset 只有这一种写法：官方 `@deepseek-ai/dsh-web-app@0.2.1-rc.2` 的
`presets/standard.patch.yml` 第 6 行也是 `name: '@deepseek-ai/dsh-agent-preset'`（ptc/minimal/cordis
同）；其 `cordis.patch.yml` 注释写明 shipped preset 是 `presets/` 下的独立 patch 文件。本包只是用同一
机制承载自有 preset（id `molbio-lab`），新增 entry 只有 `molbio-client`、`preset-molbio-lab`，没有
disabled、没有覆盖官方行。

请求：按**解析后的 `insertedEntries`** 判定保护命名空间，并对
`name === '@deepseek-ai/dsh-agent-preset'` 且 `config.id` 为插件自有 id 的容器行放行；
`config.plugins` 按配置处理，不按入口；仍然禁止 `disabled`、禁止覆盖官方 entry id、禁止把官方包名
作为被插入的实现。

**2. 身份规则拒绝了惰性锚点行，而改成子路径会让面板消失**

`- id: molbio-client` / `name: './host.mjs'` 是浏览器半的宿主锚点（不注册任何工具，只为让 DSH 的
客户端模块扫描能发现本包的 `dsh.client`）。身份规则要求插入行解析到本包，看起来可以改成
`dsh-molbio-tools/host`——**不行**：

`@deepseek-ai/dsh-client-modules` 的 `exactPackageSpecifier` 只接受 `@scope/name` 或裸包名，任何含
`/` 的非 scoped 说明符返回 `undefined`，`locatePkgJson` 随即返回 `undefined`，该行永远不会被客户端
扫描发现，右栏 Molbio/Papers 两个 tab 会静默消失。改成包根 `dsh-molbio-tools` 也不可行：根模块是
工具入口，会把 60 个工具注册进该 profile 的每个会话——这正是本包要避免的。

请求：允许「`name` 以 `./` 开头、解析基准为 manifest 所在包目录、解析结果留在包内且文件已分发」的
自引用 insert 行；或把本固定 commit 送入人工专项审阅，按实际内容判定。

完整说明（官方文件路径、代码位置、可复现方式）：
https://github.com/lovy2004/dsh-molbio-tools/blob/main/docs/store-preset-exemption.md
