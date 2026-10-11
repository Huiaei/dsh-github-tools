# dsh-github-tools

[English](README.md) · **简体中文**

> [!WARNING]
> **你的 GitHub token 是以明文形式存储的。**
> 本插件没有加密，没有 keyring，也没有密钥管理器。如果你把 token 输入到它的配置页面，
> 该 token 就会作为一个普通的 YAML 字符串被写入
> `$DSH_HOME/profiles/<profile>/cordis.patch.yml` —— 任何以你的用户身份运行的进程都能读到它，
> **该 profile 中的任何 agent 会话**都能读到它，DSH 自身的配置备份与同步也会带着它一起走。
> 请把这个 token 当作磁盘上的一个文件来对待，因为它事实上就是。请使用短时效、最小权限的
> token，或者干脆让 token 完全不进入该文件 ——
> 参见 [Token 与密钥存储](#token-与密钥存储)。

> [!CAUTION]
> **本仓库是由 AI 编写的，而不是由人类编写的。**
> 移植代码、schema、测试、文档 —— 每一行 —— 都是由一个 AI agent 依据上游
> [github/github-mcp-server](https://github.com/github/github-mcp-server)
> 源码生成的。没有任何人类维护者审查过它。它与 GitHub、Microsoft 或 DeepSeek 没有关联，
> 也未获得它们的背书或支持。其中有若干工具会对你的账号执行**破坏性且不可逆**的操作：
> `delete_repository`、`merge_pull_request`、`push_files`、`delete_file`、
> `update_issue_state` 等等。这里的任何内容都未经安全审计。

> [!IMPORTANT]
> **使用它完全由你自己承担风险。**
> 不提供任何形式的担保，无论明示还是默示 —— 参见 [LICENSE](LICENSE)。你需要为这些工具对
> 你的仓库所做的操作、为你交给它们的凭据、以及为你让语言模型看到的数据负责。如果这不是
> 你愿意做的交易，请不要安装它。

完整的 [github-mcp-server](https://github.com/github/github-mcp-server) 工具集 ——
**131 个 GitHub 工具** —— 被重新实现为 **DeepSeek Harness (Cordis) 原生插件工具**。

没有 MCP server，没有子进程，没有传输层，也没有 `mcp__github__*` 名称前缀：每个工具都直接
注册在 harness 的 `tools` 服务上，并通过普通的 `fetch` 调用 GitHub REST 与 GraphQL API。

```
GitHub REST / GraphQL  ←  src/client.js  ←  src/handlers/*.js  ←  ctx.tools.register  ←  DSH
```

目录：[你能得到什么](#你能得到什么) · [环境要求](#环境要求) · [安装](#安装) ·
[Token 与密钥存储](#token-与密钥存储) · [配置](#配置) ·
[设置界面](#设置界面) · [工具](#工具) · [工作原理](#工作原理) ·
[开发](#开发) · [故障排查](#故障排查) ·
[保真度与局限](#保真度与局限) · [与上游的差异](#与上游的差异) · [常见问题](#常见问题)

## 你能得到什么

| | MCP stdio server | Remote MCP (HTTP) | **本插件** |
| --- | --- | --- | --- |
| 进程模型 | 常驻子进程，每个会话一个 | 本地无 | 无 —— 普通的进程内模块 |
| 启动开销 | 每次激活都要探测进程 + 握手 | 每次调用一次网络往返 | 无 |
| 故障模式 | 崩溃的子进程会消耗重连预算 | 远端可用性 | 一个普通的进程内异常 |
| 工具名称 | `mcp__github__<tool>` | `mcp__github__<tool>` | `<tool>`（例如 `issue_read`） |
| 认证 | 交给子进程的环境变量 | GitHub 托管的 OAuth | 插件配置，或 `GITHUB_PERSONAL_ACCESS_TOKEN` |
| 新增一个工具的成本 | 重新编译 Go 二进制 / 等待上游 | 不由你掌控 | 添加一个 handler 函数 |

- **131 个工具**，分布在 **26 个 toolset** 中（其中 22 个目前携带工具），其中 60 个是只读的。
- **零运行时依赖。** 纯 ESM，没有构建步骤，没有打包器，没有任何需要编译的东西。
- **可在 GUI 中配置**，并带有一个随同一 bundle 一起发布的浏览器端部分。
- 工具清单（名称、描述、参数 schema、只读标注）是
  **从上游仓库的 `__toolsnaps__` 生成的**，因此模型看到的接口面与 Go server 一致。
  handler 则是上游 Go 实现的移植。

## 环境要求

| | |
| --- | --- |
| DSH | `>= 0.1.7-rc.2`（声明于 `engines.dsh`）；peer 包 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery` 由宿主提供 |
| Node | `>= 20`（声明于 `engines.node`） |
| 构建 | 无 —— 发布的包就是源码 |
| 网络 | 到 `api.github.com` / `github.com`（或你的 GitHub Enterprise 主机）的 HTTPS |

## 安装

安装一个 bundle 是 **profile 级**的操作：bundle patch 会插入一行进程级配置，因此该 profile 中
的每个 agent preset 都无需声明任何东西即可获得这些工具。需要重启 DSH 该行才会生效。

### 1. 使用 `dsh` CLI（受支持的方式）

DSH 提供了一个 `dsh` 命令来管理 profile 的插件：

```bash
dsh plugin --profile <profile> add <spec>
```

它会在 **profile 目录内**运行 pnpm，然后对结果进行协调：它会锁定 profile 的 `package.json`，
检查插件的 peer 与运行时要求，在某个包未声明 `dsh.bundle` 时给出警告，校验 bundle 的 patch
文件，并且 —— 如果该包声明了的话 —— **替你把这个包追加到 `dsh.profile.bundles`**。之后无需
手工编辑任何东西。

`<spec>` 可以是 pnpm 接受的任何形式；DSH 会在使用前校验它的形态。本包**并未发布到 npm
registry**，因此请使用仓库或本地路径：

| spec 类型 | 示例 |
| --- | --- |
| git 仓库 | `dsh plugin --profile desktop add github:Huiaei/dsh-github-tools` |
| 托管的仓库 URL | `dsh plugin --profile desktop add https://github.com/Huiaei/dsh-github-tools` |
| 本地 tarball | `dsh plugin --profile desktop add /abs/path/dsh-github-tools-1.3.0.tgz` |
| 本地 checkout | `dsh plugin --profile desktop add /abs/path/dsh-github-tools` |
| npm 包 | `dsh plugin --profile desktop add dsh-github-tools`（发布之后） |

本地路径必须是绝对路径；也接受 `file:` 和 `link:` 前缀。

两个约束：

- `--profile` 是必需的 —— 一个插件只属于一个 profile。
- 对于保留的 `desktop` profile，应用必须已经初始化过该 profile，并且在该命令运行期间必须
  **完全退出**：*“先打开一次 DeepSeek Harness Desktop 以初始化它的 profile，然后在运行
  `dsh plugin --profile desktop` 之前完全退出它。”*

在 DSH Desktop 上，可执行文件是 `<install>/resources/runtime/cli/bin/dsh.cmd`（Windows）——
把它放到 `PATH` 上，或者用完整路径调用它。在通过 npm 安装的 harness 上，`dsh` 已经在 `PATH`
上。

DSH 会拦截它自己的少数几个子命令（`allow-version`、`revoke-version`、…）；其余一切都会原样
转发给 pnpm，因此 `remove`、`why`、`list` 之类的命令行为照旧。

### 2. 通过 GUI 安装

Plugins 页面使用相同的 spec 语法进行安装。等价的工具调用是：

```
plugin_manager({ action: "install_bundle", target: "<path to .tgz, or an npm spec>" })
```

它会报告 `application: "restart-required"`。

### 3. 手动安装

仅当上面两种方式都不可用时：

```bash
cd "$DSH_HOME/profiles/<profile>"
pnpm add /path/to/dsh-github-tools-1.3.0.tgz
```

然后把包名加入该 profile 的 `package.json`：

```json
{
  "dsh": { "profile": { "bundles": ["…", "dsh-github-tools"] } }
}
```

并重启 DSH。两处修改都是必需的：依赖把代码放到磁盘上，bundle 条目则激活它的 patch。源码
checkout 也是同样的做法 —— 把依赖指向该 checkout（`pnpm add /path/to/dsh-github-tools`，或
一个 `"file:…"` spec），而不是指向 tarball。没有构建步骤，因此 checkout 可以直接运行。

### 验证是否加载成功

该行应当处于 active 状态，并且浏览器端部分解析到 `src/index.js`：

```
plugin_manager({ action: "list_plugins" })
→ { "entryId": "include:github-tools", "enabled": true, "fiberPhase": "active" }
```

然后让模型调用 `get_me`。token 可用时它会返回你的 login；没有 token 时它会返回 GitHub 自己的
`Requires authentication`，这意味着链路是通的，只是缺少凭据。

## Token 与密钥存储

**在你把 token 输入到任何地方之前，请先读这一节。**

本插件中没有加密，harness 的插件配置层中也没有。插件的 `token` 字段就是普通 YAML 文件里的
一个普通字符串。配置页面通过 harness 的 `configForms` 服务写入，该服务会持久化到 profile 的
patch 文档：

```
$DSH_HOME/profiles/<profile>/cordis.patch.yml
  - id: github-tools
    config:
      token: ghp_xxxxxxxxxxxxxxxxxxxx        # ← plaintext, right there
```

这在实践中意味着：

- **任何能读到该文件的人都能拿到你的 token。** 在 Windows 上真正的保护是你用户 profile 上的
  ACL，而不是文件权限位（从 WSL 查看 `/mnt/c` 永远报告 `777`）。
- **该 profile 中的任何 agent 会话都能读到它。** agent 用来干活的那套 shell 和文件工具同样
  可以读取该 patch 文档。一个被 prompt 注入的 agent 不需要任何漏洞就能把它外泄。
- **它会跟着走。** DSH 的配置备份与同步会携带 profile 文档，因此该 token 会去到备份去到的
  任何地方。
- **`redactSecrets` 在这里帮不上忙。** 当配置值跨越线路边界时，harness 会剥离
  `role('secret')` 字段，并回传一个 `{path, set}` sidecar，使远端界面能够渲染一个只写输入框
  而不接收该值。那是线路边界的控制，不是磁盘加密。没有任何东西会给该文件脱敏。

### 该怎么办

挑一个；前两条才是真正重要的。

1. **使用细粒度（fine-grained）且短时效的 token。** 只授予你真正需要的仓库和权限，并设置
   有效期（30–90 天）。泄露的细粒度 token 影响范围有限；泄露的经典 `ghp_` token 若带有
   `repo` + `workflow` 则不然。GitHub 的细粒度表单：
   <https://github.com/settings/personal-access-tokens/new>。
   配置页面链接的是经典表单，并预填了本工具集所需的 scope，那是方便的选择，而不是最安全的
   选择。
2. **让 token 不进入该文件。** 把 `token` 留空，改为在环境变量中导出它。解析顺序是
   `config.token` → `config.tokenEnv`（默认 `GITHUB_PERSONAL_ACCESS_TOKEN`）→ `GITHUB_TOKEN`
   → `GH_TOKEN`，因此留空 `token` 是一种受支持的一等配置。DSH 在启动时会把
   `$DSH_HOME/.env` 加载进进程环境（`process.loadEnvFile`），所以：

   ```bash
   # $DSH_HOME/.env — gitignored, and not part of the profile's config document
   GITHUB_PERSONAL_ACCESS_TOKEN=github_pat_…
   ```

   这换来的是*隔离*，而不是加密：`.env` 文件同样是明文。它避免的是 token 随每一次配置备份、
   同步和 profile 快照一起被带走。
3. **或者用 loader 表达式让字面量不进入该文件。** loader 接受配置值中的表达式，因此这是合法
   的 YAML：

   ```yaml
   - id: github-tools
     config:
       token: !!js process.env.GITHUB_PERSONAL_ACCESS_TOKEN
   ```

   注意事项：配置表单写入的是普通值，所以之后不要在 token 字段上按保存，否则你会把这个
   表达式压平回字面量。

### 插件确实做到的事

- GUI 中的 token 字段是一个**只写**控件：已存储的 token 永远不会被回显，空的草稿不会写入
  任何内容，因此保存表单的其余部分不会把它抹掉。
- token 只会通过 HTTPS、以 `Authorization` 头的方式发送到配置的 GitHub 主机。不会记录任何
  日志，也不收集任何遥测。
- 插件不会预先检查 token 的 scope；GitHub 会以通常的 403/404 作答。

## 配置

| 键 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `token` | string | `''` | PAT 或 GitHub App installation token |
| `tokenEnv` | string | `GITHUB_PERSONAL_ACCESS_TOKEN` | 当 `token` 为空时优先查询的环境变量 |
| `host` | string | `github.com` | `github.com`，或 GitHub Enterprise Server 主机名 |
| `apiBaseUrl` | string | 派生 | 覆盖 REST base（`https://api.github.com`、`https://<host>/api/v3`） |
| `graphqlUrl` | string | 派生 | 覆盖 GraphQL endpoint |
| `toolsets` | string[] | `['default']` | 要启用的 toolset；`['all']` 启用全部 131 个 |
| `tools` | string[] | `[]` | 显式的工具名；非空时它会**取代** `toolsets` |
| `excludeTools` | string[] | `[]` | 从选择中移除的工具名（最后应用） |
| `readOnly` | boolean | `false` | 只注册上游标注 `readOnlyHint: true` 的工具（131 个中的 60 个） |
| `deferLoading` | boolean | `false` | 要求 harness 把定义的加载推迟到首次使用时 |
| `timeoutMs` | number | `60000` | 每次调用的 HTTP 超时 |
| `retries` | number | `2` | `429`/`5xx` 的重试次数（遵循 `Retry-After`） |
| `userAgent` | string | `dsh-github-tools` | `User-Agent` 头 |
| `maxItems` | number | `1000` | 单次分页调用所收集条目数的上限 |

默认集合（上游 `default: true` 的那些 toolset）是 `context`、`repos`、`issues`、
`pull_requests`、`users`、`copilot` —— 共 86 个工具。`toolsets: ['all']` 注册全部 131 个。

选择顺序：`tools`（若非空）→ `toolsets` → `readOnly` → `excludeTools`，最后应用。每个字段
都是一个 *volatile* 配置叶子节点，因此**在 GUI 中所做的修改会实时生效** —— 更改 `toolsets`、
`readOnly`、`excludeTools` 或 `token` 会在运行中的会话里重新注册工具集，无需重启。（安装或
移除 bundle 本身仍然需要重启。）

### 通过文件配置

不用 GUI 时，同样的值可以放在本 bundle 自己的 `cordis.patch.yml` 中，或放在 profile 的
`cordis.patch.yml` 中按 id 覆盖：

```yaml
- id: github-tools
  config:
    toolsets: [repos, issues, pull_requests]
    readOnly: true
```

在更靠后的 patch 层中按 id 覆盖该行（`- id: github-tools` 配 `disabled: true`），即可把这些
工具排除在某个特定组合之外。

## 设置界面

该 bundle 附带一个浏览器端部分，因此它的配置可以在 GUI 中编辑。进入同一个表单有两扇门：

- **Settings → GitHub tools** —— Settings 面板中该插件自己的条目。
- **Settings → Plugins → `dsh-github-tools` 行 → Configure** —— Plugins 页面上该行的页面。

该表单通过 harness 的 `configForms` 服务写入，以 Loader 行 id `github-tools` 寻址，并使用
宿主自己的表单原语渲染，因此它会跟随主题和语言环境。token 控件直接链接到 GitHub 的 token
表单，并预填了本工具集所需的 scope。

## 工具

| toolset | 工具数 | 默认 | 上游描述 |
| --- | ---: | :---: | --- |
| `context` | 4 | 是 | 提供关于当前用户和 GitHub 上下文的工具 |
| `repos` | 21 | 是 | 仓库相关工具 |
| `git` | 1 | — | 底层 Git 操作 |
| `issues` | 31 | 是 | issue 相关工具 |
| `pull_requests` | 27 | 是 | pull request 相关工具 |
| `users` | 1 | 是 | 用户搜索 |
| `orgs` | 1 | — | 组织搜索 |
| `governance` | 4 | — | ruleset 与自定义属性 |
| `actions` | 4 | — | Actions workflow 与 CI/CD |
| `code_quality` | 1 | — | Code Quality 发现项 |
| `code_security` | 2 | — | code scanning 告警 |
| `secret_protection` | 2 | — | secret scanning 告警 |
| `dependabot` | 2 | — | Dependabot 告警 |
| `notifications` | 6 | — | 通知管理 |
| `discussions` | 5 | — | discussions |
| `gists` | 4 | — | gists |
| `security_advisories` | 4 | — | 全局与仓库安全公告 |
| `projects` | 3 | — | Projects v2 |
| `stargazers` | 3 | — | 收藏仓库 |
| `labels` | 2 | — | label 的读取与写入 |
| `copilot` | 2 | 是 | Copilot 指派与审查 |
| `copilot_issue_intents` | 1 | — | 带 intent 元数据的 opt-in Copilot 指派 |

`all`、`default`、`copilot_spaces` 和 `github_support_docs_search` 是 meta/空 toolset：
它们用于选择其他 toolset，或者目前在上游不暴露任何工具。

每个工具的完整清单 —— 名称、描述、toolset、源文件和源函数 ——
生成于 [`docs/TOOLS.md`](docs/TOOLS.md)。

## 工作原理

```
src/
  index.js            the Cordis plugin: Config, inject, apply(), tool registration
  client.js           GitHubClient — REST/GraphQL, Link pagination, retries, typed errors
  schema.js           upstream JSON Schema → the harness's supported schema dialect
  select.js           toolset / tools / excludeTools / readOnly resolution
  render.js           handler result → the text content block the model sees
  util.js             shared argument and response helpers
  generated/
    tools.json        131 tool definitions, extracted from the upstream __toolsnaps__
    toolsets.json     26 toolset definitions
    data.js           loads both
  handlers/
    index.js          merges the 14 handler modules, reports duplicates
    context.js        get_me, get_teams, get_team_members, ui_get, search_users, search_orgs
    repos.js  issues.js  issues_granular.js  pull_requests.js  pr_granular.js
    actions.js  security.js  governance.js  notifications.js  discussions.js
    gists.js  labels.js  copilot.js
client/
  index.js            the browser half: the Settings entry, the row page, the form
```

每个 handler 都是 `async (args, ctx) => plainObject`；`ctx` 携带 `client`、`config`、`log`
和 `signal`。注册、schema、超时和渲染都在 `src/index.js` 中，因此 handler 从不接触 harness。
参见 [`docs/HANDLER-CONTRACT.md`](docs/HANDLER-CONTRACT.md)。

如果你打算修改本插件，有两个 harness 特有的细节值得了解：

- 插件的 `Config` 必须能作为**模块命名空间上的具名导出**访问到。`export default apply` 与
  `export const Config` 并列时会被 loader 解包成裸函数，配置行随后会报告
  `status: "absent"` —— 插件能加载，但它没有设置项。这里刻意不提供 default export。
- 每个配置字段都是 `.volatile()`。harness 只会为至少拥有一个 volatile 字段的条目提供配置
  命名空间；没有它们，Settings 页面会永远等待一个永远不会到来的命名空间。

## 开发

```bash
node scripts/generate.mjs          # regenerate src/generated/* from a github-mcp-server checkout
node scripts/verify.mjs            # inventory + schema-dialect + handler-coverage check
node --test "tests/**/*.test.mjs"  # unit tests
```

`scripts/generate.mjs` 会从一个 github-mcp-server checkout 读取
`pkg/github/__toolsnaps__/*.snap` 和 Go 源码（默认 `/tmp/gh-mcp`，可用 `--source <dir>`
覆盖）；它把每个工具映射到它的 toolset、源文件和源函数，并重写 `docs/TOOLS.md`。它是确定性
的 —— 从同一个上游 commit 重新生成会产生逐字节相同的输出。

测试套件包含一个 harness JSON-Schema 校验器的本地重实现，因此生成的 schema 可以在未安装
harness 的情况下针对真实方言进行检查。

## 故障排查

| 症状 | 原因 | 修复 |
| --- | --- | --- |
| 每次调用都返回 `Requires authentication` | 没有 token 到达客户端 | 设置 `token`，或导出 `GITHUB_PERSONAL_ACCESS_TOKEN`（参见 [Token 与密钥存储](#token-与密钥存储)） |
| 对浏览器里能看到的仓库调用返回 `403`/`404` | token 的 scope 或仓库访问权限没有覆盖它们 | 插件不预先检查 scope；请检查 token 自身的权限 |
| 模型的工具列表中没有这些工具 | bundle 行被禁用，或者 profile 自安装以来尚未重启 | 检查 `fiberPhase: "active"`；bundle 安装需要重启 |
| Settings 页面没有条目，或该行没有 Configure 控件 | bundle 早于 1.1.1，或浏览器端部分没有解析 | 升级；该行必须处于 active 状态，它的浏览器端部分才会加载 |
| 配置页面一直转圈 | bundle 早于 1.1.2（没有 volatile 字段 ⇒ 没有命名空间） | 升级 |
| 更改 `toolsets` 要重启后才生效 | 1.1.2 之前的预期行为 | 在 1.1.2+ 上该更改实时生效 |
| 安装失败并报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` | pnpm 的供应链策略拒绝了比 `minimumReleaseAge` 更年轻的版本 | 把该包加入 profile 的 `pnpm-workspace.yaml` 中的 `minimumReleaseAgeExclude`，或者等过这个期限 |
| 安装失败并报 `ambiguous-install` | 同一版本上已经安装了一个不同的 tarball | 提升版本号 —— 管理器以 name + version 作为键 |
| 工具显示为 `mcp__github__*` | 那是上游 MCP server，不是本插件 | 二选一；同时运行会注册两套工具 |

## 保真度与局限

- **清单**：与上游 `__toolsnaps__` 1:1（141 个 snapshot → 131 个唯一工具；多出来的是
  `*_output` schema snapshot 以及同一工具的特性开关变体）。
- **Schema**：归一化为 harness 方言 —— `anyOf`/`$ref`/`$defs`/`minimum`/`maximum`/
  `minLength`/`x-mcp-header` 在那里无法表达，会被丢弃；保留下来的约束关键字
  （`type`、`oneOf`、`properties`、`required`、`items`、`enum`、`const`）会被保留。
- **输出**：上游的 `outputSchema` 不会被强制执行 —— 插件声明
  `output.schema = {type: 'json'}`。handler 返回 JSON 值（对象，以及在上游工具如此时返回
  数组或原始字符串），渲染为一个缩进的文本块；无论如何模型读到的就是这个。
- **Scope**：插件不预先检查 token 的 scope；GitHub 会返回通常的 403/404。
- **写工具**：与上游 server 完全一样，写工具会执行真实的变更，没有任何交互式确认。使用
  `readOnly: true` 或 `excludeTools` 来限制某个会话。
- **未经审计。** 参见顶部的警告。

### 与上游的差异

每次工具调用都会以相同的参数到达相同的 endpoint，与上游一致。差异在于*渲染结果*的形态，
而且每一处都是有意为之：

| 差异 | 位置 | 原因 |
| --- | --- | --- |
| 列表结果被包装为 `{items: [...], page, per_page}` —— 目录列表则是 `{directory: [...]}` —— 而不是上游的裸数组 | `repos.js`、`issues.js`、`pull_requests.js` 中的列表工具，以及 `get_file_contents` | 该信封携带分页信息，并在渲染后的文本中自描述；harness 不对它施加输出 schema |
| `ui_get` 返回 `{method, <method>: <payload>}` | `context.js` | 与上游声明的 `UIGetOutput` 形态一致 |
| 上游以流式或重定向方式处理的辅助项（workflow artifact、job 日志、workflow-run 日志 URL）返回 API endpoint，而不是响应体 | `actions.js` | 宿主工具返回 JSON，而不是二进制流；返回的 endpoint 会 302 重定向到该 artifact |
| 受特性开关门控的分支（`ThreadResolutionReason`、`update_issue_suggestions`、MCP-App awaiting-form 路径）不再门控 | `pull_requests.js`、`issues_granular.js` | 特性开关是上游服务端的概念；这里的行为始终开启 |
| 破坏性写入前没有交互式确认（上游会为例如 `delete_repository` 发起 elicitation） | `repos.js` | 本宿主中没有 elicitation 通道；`readOnly: true` 才是护栏 |
| 项目条目的标题由手写的 sanitizer 剥离 HTML，而不是用 HTML tokenizer | `governance.js`（`sanitizePlainText`） | 移植了上游的 `sanitize.PlainText`（代码围栏信息移除 + 标签剥离 + 尖括号中性化）而不引入新依赖；它不像上游的 tokenizer 那样解码 HTML 实体 |

上表未列出的任何内容都是对上游 Go handler 的忠实移植。

## 常见问题

**这是 GitHub 的官方工具吗？** 不是。它是对 github-mcp-server 工具接口面的独立重实现，由 AI
编写，与 GitHub 没有关联。

**它能用于 GitHub Enterprise Server 吗？** 可以 —— 把 `host` 设为该设备的主机名，
REST/GraphQL base 会被派生出来；如果你的部署不在标准路径上，请覆盖
`apiBaseUrl`/`graphqlUrl`。

**它需要 `gh` CLI 登录吗？** 不需要。插件只读取它自己的配置和 token 环境变量。

**我能把它和上游 MCP server 一起运行吗？** 可以，但你会得到两套重叠的工具，其中一套带
`mcp__github__` 前缀。二选一。

**如何让某个会话保持只读？** 设置 `readOnly: true`，或者在 `tools` 中列出你想要的工具。这会
注册 60 个只读工具，而不是 131 个。

**在哪里报告 bug？** 没有官方渠道 —— 没有人类维护者。在依赖它之前，请先阅读本文件顶部的
警告。

## 致谢

工具接口面、描述、schema 和 handler 行为均派生自
[github/github-mcp-server](https://github.com/github/github-mcp-server)（MIT）。本插件是为
DeepSeek Harness 所做的重实现，而不是再分发。

## 许可证

MIT —— 参见 [LICENSE](LICENSE)。
