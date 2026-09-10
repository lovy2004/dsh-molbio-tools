# dsh-molbio-panel

DSH Web GUI 的**浏览器内 Molbio 面板**：右侧栏的一个 tab，列出当前会话工作区的序列文件，
选中当场画出来——`.dna` / `.gb` / `.gbk` 出质粒图谱，`.fa` / `.fasta` 出序列标识图。

解析与渲染在浏览器里跑的是 [`dsh-molbio-tools`](https://github.com/lovy2004/dsh-molbio-tools)
的**同一份源码**（`lib/genbank/snapgene/plasmid/msa/logo`）——不落盘 SVG、不弹系统查看器、
不经过工具调用。

## 为什么是单独的包

面板必须走 **bundle 渠道**（`dsh.client` 双面包）：preset 渠道挂不了客户端 UI
（详见 `dsh-molbio-tools` 仓库的 `docs/client-pipeline-exploration.md`）。

而 `dsh-molbio-tools` 的宿主半边会注册 **46 个工具**——把它挂进一个共享的 Web profile，
等于给**该 profile 的每个会话**都塞进这些工具。所以面板单独成包：

| 包 | 宿主半边 | 用途 |
| --- | --- | --- |
| `dsh-molbio-tools` | 46 个 molbio 工具 | 分子生物学专用 profile / preset |
| `dsh-molbio-panel` | **不注册任何工具**（空实现） | 只想在共享 profile 里加一个面板 |

宿主半边刻意保持空：客户端扫描按 **Loader 条目**取包清单，条目只要能加载，浏览器半就能
被发现——这正是"面板与工具解耦"能成立的原因。

## 安装

```bash
dsh plugin --profile <profile> add dsh-molbio-panel          # npm 包
dsh plugin --profile <profile> add D:\path\to\packages\molbio-panel   # 本地目录
```

装完**刷新页面**（不需要重建 Web 应用）。右栏引导页里会出现 **Molbio** 胶囊。

## 用法

1. 打开右侧栏（会话头部角落的按钮），从引导页选 **Molbio**。
2. 左栏列出工作区里可打开的文件（质粒文件排在前面）。
3. 点一个 `.dna` / `.gb` → 右侧出图谱 + 特征表（Feature / Type / Start / End / Strand）；
   点一个 `.fasta`（≥2 条序列）→ 出序列标识图（信息量 bits，小样本校正默认开）。

## 限制

- **只读**：只列目录第一层，不写文件。
- 完整文件读取受部署的 `workspaceFiles` 上限约束（`maxFileBytes` 默认 **32 MiB**，
  `maxEntries` 默认 **2000**）；列表与读取的错误会原样显示在面板里。
- 特征表最多渲染 200 行（图谱本身按渲染器上限画）。
- 面板用宿主提供的 `remote` 与插槽服务；在缺少右栏（`dsh-client-ui-sidebar-right`）的
  组合里不会出现。

## 开发

产物 `lib/client.js` 由 `dsh-molbio-tools` 仓库的打包器生成（两个包在同一趟构建里产出，
因此不会漂移）：

```bash
cd <dsh-molbio-tools>
node build/client-bundle.mjs          # 同时写 lib/client.js 与 packages/molbio-panel/lib/client.js
node test/client.mjs                  # 产物格式 + 数据通路（按加载器方式执行）
node test/client-mount.mjs            # 复刻宿主侧图扫描，核对依赖与挂载
```

产物**必须与源码一起提交**：`dsh plugin add` 装的是产物，用户机器上没有构建步骤。
