# 安装渠道 B：把 preset 注册进 profile（不复制）

本文记录 **`preset/install.mjs`** 这条安装渠道：为什么需要它、它到底改什么、升级时会发生什么、
以及它相对"复制 preset 到 `~/.dsh/.agent-presets`"的取舍。所有结论都在本机对着已安装的
harness 实测过，实测方法见文末。

## 为什么需要它

`dsh plugin --profile <p> add dsh-molbio-tools` 会把包装进 profile，并让 **52 个工具**在该
profile 的所有会话里可用。但它**不会**让 preset 出现在模式选择器里：

- `dsh plugin` 管理的是 **profile bundle**（它只是 `pnpm` 的转发器，见 `dsh/lib/plugin-*.js`）；
- agent preset 只从两处发现（`@deepseek-ai/dsh-agent-presets`）：
  包自己的 `presets/` 目录，和 `<dshHome>/.agent-presets`。

于是出现了缺口：**推荐给用户的 preset 渠道需要手工复制目录**，而手工复制在升级时还要重来一遍
（版本目录规则要求每次发布新建 `dsh-molbio-tools-vN`，复制过去的那份就冻结在旧版本）。

`preset/install.mjs` 补上这个缺口：把**已安装包内的 preset 目录**注册为 profile 的额外
preset 扫描根。配置文件改一次，之后升级不用再动。

## 用法

```powershell
# 1. 把包装进 profile（工具 + bundle 层）
dsh plugin --profile web add dsh-molbio-tools

# 2. 注册 preset（幂等）—— 脚本随包分发，直接在包里执行
node <包目录>\preset\install.mjs --profile web
#    典型位置：<profile>/node_modules/dsh-molbio-tools/preset/install.mjs
#    开发检出：<仓库>/preset/install.mjs（若 profile 里已装该包，脚本会自动优先用装好的那份）
```

参数：

| 参数 | 作用 |
| --- | --- |
| `--profile <name>` | 要注册的 profile，默认 `web` |
| `--dsh-home <path>` | harness home，默认 `$DSH_HOME`，否则 `~/.dsh` |
| `--dry-run` | 只打印将要写入的条目，不落盘 |
| `--check` | 只校验是否已注册，未注册时退出码 1（可做健康检查） |

装好后**重启该 profile**，新建会话时选择器里会出现 **Molecular Biology Lab**。

> 在受限沙箱里运行时，脚本可能无法启动 `dsh --dump-config` 做自检（子进程管道被拒绝，报
> `EPERM`）。脚本会区分两种情况并明确提示：**跑不起来**只是警告（补丁已写入，退出码 0）；
> **跑起来但结果不对**才判定失败（退出码 1，并提示从备份恢复）。请按提示自行 compose 验证。

## 它到底改什么

在 profile 的 `cordis.patch.yml` 里加一条针对 roster 行的补丁：

```yaml
- id: agent-presets
  config:
    default: standard
    roots:
      - path: <已安装包>/preset
        trust: system
```

四个要点，每个都有原因：

1. **`config` 是整体替换**，不是合并 —— harness 的补丁语义如此，所以必须重述 `default`。
2. **`roots.path` 必须是绝对路径** —— 发现层用 `path.resolve(expandHomePath(path))` 解析，
   相对路径会按**进程 CWD**解析（app-boot 全程不 `chdir`），随启动目录漂移。
   `~` 前缀可用，但我们的路径在 `$DSH_HOME` 下，`~` 展开不到，所以由脚本写入绝对路径。
3. **`trust: system`** —— 该目录属于包，只读是正确语义：它不能被用户从 preset UI 编辑/删除
   （`trust !== 'user'` 时删除会被拒），也不会去查内置显示名（那对 `system` 且命中内置键的才查），
   显示名照常来自 `preset.yml`。**不要关 `includeUserRoot`**，否则 `writableRoot` 失效，
   "创作 preset" 入口整体不可用。
4. **`[]` 占位符必须被替换而不是追加** —— 新初始化的 profile 的 patch 文件内容就是裸的
   `[]`；在它后面追加会产生第二个顶层节点，harness 报
   `end of the stream or a document separator is expected`。脚本按"只剩注释 + `[]`"判定并替换。

脚本先备份（`cordis.patch.yml.bak-<时间戳>`）再写，写入后用 `dsh --profile <p> --dump-config`
验证组合树确实带上了新 root。

## 升级会发生什么

这是这条路线的核心价值。**升级只跑一条命令，不用动任何配置、不用重新复制**：

```powershell
dsh plugin --profile web update dsh-molbio-tools
```

为什么这就够了：

- **root 路径跨版本恒定**：包始终落在 `<profile>/node_modules/dsh-molbio-tools`（`link:` 安装是
  符号链接，npm/tarball 安装是真实目录）。实测把安装来源从 `link:` 换成 tarball 后，注册的
  root 路径没有变化，`--check` 仍然通过。
- **新会话自动用上新代码**：preset 挂载按 `agent.cordis.yml` 的 `{mtimeMs, size}` 戳判定代际
  （`agent-presets/lib/types/index.js` 的 `ensureStanding`），戳一变就为**新会话**开新一代。
  发布时该文件里的行会指向新的 `dsh-molbio-tools-vN`，所以新代码随之生效。
- **不会撞 ESM 缓存**：插件内部 import 全是相对路径（`./lib.mjs` 等），新版本目录产生全新
  文件 URL，模块缓存自然未命中 —— 这正是仓库"版本目录规则"能成立的原因。

### 升级 Runbook（三条必须遵守的纪律）

1. **别立刻删旧的 `vN` 目录。** 已加入旧世代的运行中会话仍指回旧目录；删掉会让它们的后续
   工具调用找不到模块。README 里"旧目录可删除（已运行 generation 持有内存中的模块）"是
   **同一进程内热升级**的说法，不适用于这种跨进程的 `pnpm update`。等老会话结束后再删。
2. **发布时 preset 目录里的插件拷贝要一起更新。** 包内 `preset/molbio-lab/plugins/dsh-molbio-tools-vN/`
   是独立的一份 `.mjs` 拷贝（preset 必须自包含），发布流程要把 `agent.cordis.yml` 的行和这份
   拷贝同步推进。
3. **patch 必须重述 `default` 与两个 `include*`。** 见上文第 1、3 点；漏写 `default` 会直接校验失败。

### 升级后出问题怎么看

preset 组合里有行解析不了时，发现层会把它列为 **broken 并给出原因**，而不是悄悄隐藏
（这是设计如此）。所以"选择器里 preset 不见了/标红"要去预设列表看原因，通常是：
包被卸了、`vN` 目录没跟上、或 profile 没重启。

## 与复制方案的取舍

| | 复制到 `~/.dsh/.agent-presets` | 本渠道（注册包内目录） |
| --- | --- | --- |
| 安装动作 | 复制整个 preset 目录（2.4 MB，含历史 `vN`） | 跑一次脚本（改 8 行配置） |
| 升级动作 | **每个新版本都要重新复制**到新的 `vN` 目录 | `dsh plugin update`，**配置不动** |
| 升级丢失风险 | 高（忘记复制 → 跑旧代码） | 无（路径恒定，随包更新） |
| preset 是否自包含 | 是（可离线带走） | 依赖已安装的包 |
| 可否被用户编辑 | 可以（在 user 根下） | 否（`trust: system`，只读） |
| 适用场景 | 无法改 profile 配置的环境；要交付一个"带走即用"的目录 | 自己的机器/团队 profile；长期使用并跟随升级 |

两者可以共存（复制那份在 `user` 根，本渠道在配置根，重复 id 时**配置根胜出**）。
若同时存在且希望完全跟随包升级，删掉 `~/.dsh/.agent-presets/molbio-lab` 即可。

## 实测方法（可复现）

全部在临时 `DSH_HOME`（工作区内，不触碰真实 `~/.dsh`）上做：

```powershell
$env:DSH_HOME = "D:\path\to\tmp-dsh-home"
dsh --profile web --help                                   # 初始化一个真实 web profile
dsh plugin --profile web add link:<仓库路径>                # 装入包
node preset/install.mjs --profile web --dsh-home $env:DSH_HOME
dsh --profile web --dump-config                            # 组合树应带上新 root
```

验证覆盖：组合树解析与 root 出现、幂等（二次运行零改动）、`--check`、`--dry-run` 不落盘、
无 roster 行的 profile 被守卫拒绝、发现层对**已安装副本**判定 `healthy` 且四个内置 preset 仍在、
安装来源从 `link:` 换成 tarball 后 root 路径不变。补丁形状还用 harness 自己的 YAML 解析器
跑了 5 种边界（裸 `[]`、无尾换行、CRLF、已有条目、已有条目无尾换行）。

## 已知限制

- **不是零配置。** 仍要跑一次脚本（改 profile 配置）。真正的零配置需要 harness 提供
  `dsh preset add`，或允许 bundle 自带 preset 发现根 —— 目前都没有。
- **依赖 profile 的 roster 行存在。** 只有包含 `@deepseek-ai/dsh-web-app` 的 profile
  （如随附 `web` 模板）才有 `agent-presets` 行；脚本会先检查 bundle 列表并明确拒绝其它 profile。
- **包名 vs root 平面的耦合。** preset 中若新增**需要从 profile 解析的裸包名行**，其健康检查
  依赖发现时的 base 落在 harness/profile 平面。当前 preset 只有一行相对 specifier，不受影响。
- **沙箱**：脚本要写 `$DSH_HOME` 下的文件，受限沙箱可能拒绝；且其自检子进程可能被拒绝（见上文）。
