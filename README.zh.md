# dsh-github-tools

> [!WARNING]
> **你的 GitHub token 是明文保存的。**
> 本插件没有加密、没有 keyring、没有密钥管理。你在配置页里填入的 token 会以普通 YAML 字符串写进
> `$DSH_HOME/profiles/<profile>/cordis.patch.yml` —— 任何以你的用户身份运行的进程都能读，**该 profile 里
> 任何 agent 会话也能读**，并且会随 DSH 的配置备份与同步一起被带走。请把它当成磁盘上的一个文件来对待：
> 用短期、最小权限的 token，或者干脆别把 token 放进文件里 —— 见 [Token 与密钥存储](#token-与密钥存储)。

> [!CAUTION]
> **本仓库由 AI 编写，不是人写的。**
> 移植代码、schema、测试、文档 —— 每一行都由 AI agent 依据上游
> [github/github-mcp-server](https://github.com/github/github-mcp-server) 的源码生成，没有任何人类维护者
> 审阅过。它与 GitHub、微软、DeepSeek 均无隶属或背书关系。其中多个工具会对你的账号执行**不可逆的破坏性
> 操作**：`delete_repository`、`merge_pull_request`、`push_files`、`delete_file`、`update_issue_state` 等。
> 它没有经过任何安全审计。

> [!IMPORTANT]
> **使用风险完全自负。**
> 不提供任何形式的担保 —— 见 [LICENSE](LICENSE)。这些工具对你的仓库做了什么、你交给了它们什么凭据、
> 你让模型看到了哪些数据，都由你自己负责。如果不能接受，请不要安装。

把 [github-mcp-server](https://github.com/github/github-mcp-server) 的**全部 131 个工具**重写为
**DeepSeek Harness（Cordis）原生工具**。

没有 MCP 服务器、没有子进程、没有传输层、也没有 `mcp__github__*` 前缀：每个工具都直接注册到宿主的
`tools` 服务上，用普通 `fetch` 调用 GitHub REST 与 GraphQL API。

```
GitHub REST / GraphQL  ←  src/client.js  ←  src/handlers/*.js  ←  ctx.tools.register  ←  DSH
```

## 为什么不直接跑 MCP 服务器？

| | MCP stdio | 远程 MCP (HTTP) | **本插件** |
| --- | --- | --- | --- |
| 进程模型 | 常驻子进程，每个会话一个 | 本地无进程 | 无 —— 纯进程内 ESM 模块 |
| 启动开销 | 每次激活都要探测进程 + 握手 | 每次调用一次网络往返 | 无 |
| 故障形态 | 子进程崩溃会消耗 reconnect 预算 | 依赖远端可用性 | 普通进程内异常 |
| 工具名 | `mcp__github__<tool>` | 同左 | `<tool>`（如 `issue_read`） |
| 鉴权 | 把环境变量交给子进程 | GitHub 托管 OAuth | 插件配置或 `GITHUB_PERSONAL_ACCESS_TOKEN` |
| 新增一个工具的成本 | 重编译 Go 二进制 / 等上游 | 不可控 | 加一个 handler 函数 |

工具清单（名称、描述、参数 schema、只读标注）是**从上游仓库的 `__toolsnaps__` 生成的**，因此模型看到
的接口与 Go 服务器一致；handler 则是上游 Go 实现的移植。

## 安装

安装是 **profile 级**操作，装完需要重启 DSH 才能激活。

```bash
# 1) 通过插件管理器（推荐）：GUI 里操作，或调用 plugin_manager 工具
plugin_manager({ action: "install_bundle", target: "<.tgz 路径，或 npm spec>" })

# 2) 手工：把包装进 profile，再把包名加进该 profile package.json 的 dsh.profile.bundles
cd "$DSH_HOME/profiles/<profile>" && pnpm add /path/to/dsh-github-tools-1.3.0.tgz
```

两处改动都需要：依赖把代码放上磁盘，`bundles` 条目才会激活它的补丁。指向源码检出目录同理（`file:…`
或直接 `pnpm add <目录>`），本包没有构建步骤，检出即可运行。

bundle 补丁（`cordis.patch.yml`）只插入一行进程级插件，所有 agent preset 都能直接用这些工具。若要在某个
组合里排除，请在更后面的补丁层里按 id 覆盖该行（`- id: github-tools` 加 `disabled: true`），不要重复插入。

### Token

设置 `GITHUB_PERSONAL_ACCESS_TOKEN`（依次还会尝试 `GITHUB_TOKEN`、`GH_TOKEN`），或把 token 写进插件行的
`config.token`。没有 token 时插件依然注册成功，但每次调用都会返回 HTTP 401。**注意 token 是明文落盘的**，详见上文。

## 配置

| 键 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `token` | string | `''` | PAT 或 GitHub App 安装令牌 |
| `tokenEnv` | string | `GITHUB_PERSONAL_ACCESS_TOKEN` | `token` 为空时优先读取的环境变量 |
| `host` | string | `github.com` | `github.com` 或 GitHub Enterprise 主机名 |
| `apiBaseUrl` | string | 自动推导 | 覆盖 REST 基址 |
| `graphqlUrl` | string | 自动推导 | 覆盖 GraphQL 端点 |
| `toolsets` | string[] | `['default']` | 启用哪些 toolset；`['all']` 启用全部 131 个 |
| `tools` | string[] | `[]` | 显式工具名；非空时**取代** `toolsets` |
| `excludeTools` | string[] | `[]` | 从选择结果中剔除（最后生效） |
| `readOnly` | boolean | `false` | 只注册上游标记 `readOnlyHint: true` 的工具 |
| `deferLoading` | boolean | `false` | 请求宿主延迟加载工具定义 |
| `timeoutMs` | number | `60000` | 单次 HTTP 超时 |
| `retries` | number | `2` | `429`/`5xx` 重试次数（遵守 `Retry-After`） |
| `userAgent` | string | `dsh-github-tools/1.0.0` | `User-Agent` |
| `maxItems` | number | `1000` | 单次分页调用收集条目上限 |

默认集合（上游 `default: true` 的 toolset）为 `context`、`repos`、`issues`、`pull_requests`、`users`、
`copilot`，共 86 个工具；`toolsets: ['all']` 注册全部 131 个。

### 设置放在哪里

本包带一个浏览器半（`client/index.js`），所以配置可以直接在界面里改：
**设置 → GitHub 工具**，或 **设置 → 插件 → `dsh-github-tools` 这一行 → 配置**。页面通过宿主的 `configForms` 服务读写，
按 Loader 行 id `github-tools` 寻址。

没有界面时，同样的值就在本包的 `cordis.patch.yml` 那一行里，或写在 profile 的
`cordis.patch.yml` 中按 id 覆盖：

```yaml
- id: github-tools
  config:
    token: ghp_…
    toolsets: [all]
```

## 工具分布

| toolset | 数量 | 默认 | 说明 |
| --- | ---: | :---: | --- |
| `context` | 4 | 是 | 当前用户与 GitHub 上下文 |
| `repos` | 21 | 是 | 仓库读写、文件、提交、发布、搜索 |
| `git` | 1 | — | 底层 Git 操作（仓库树） |
| `issues` | 31 | 是 | Issue 读写、评论、子任务、依赖、字段 |
| `pull_requests` | 27 | 是 | PR 读写、评审、线程、评论 |
| `users` | 1 | 是 | 用户搜索 |
| `orgs` | 1 | — | 组织搜索 |
| `governance` | 4 | — | ruleset 与自定义属性 |
| `actions` | 4 | — | Actions 工作流与 CI/CD |
| `code_quality` | 1 | — | Code Quality 发现 |
| `code_security` | 2 | — | 代码扫描告警 |
| `secret_protection` | 2 | — | 密钥扫描告警 |
| `dependabot` | 2 | — | Dependabot 告警 |
| `notifications` | 6 | — | 通知管理 |
| `discussions` | 5 | — | 讨论区 |
| `gists` | 4 | — | Gist |
| `security_advisories` | 4 | — | 全局与仓库安全公告 |
| `projects` | 3 | — | Projects v2 |
| `stargazers` | 3 | — | 收藏仓库 |
| `labels` | 2 | — | 标签读写 |
| `copilot` | 2 | 是 | Copilot 指派与评审 |
| `copilot_issue_intents` | 1 | — | 带意图元数据的 Copilot 指派 |

`all`、`default`、`copilot_spaces`、`github_support_docs_search` 是元 toolset 或上游暂未提供工具的 toolset。

## 结构

```
src/
  index.js            Cordis 插件：Config、inject、apply()、工具注册
  client.js           GitHubClient —— REST/GraphQL、Link 分页、重试、类型化错误
  schema.js           上游 JSON Schema → 宿主 author schema DSL
  select.js           toolset / tools / excludeTools / readOnly 解析
  render.js           handler 返回值 → 模型看到的文本块
  util.js             共享参数与响应辅助函数
  generated/          由上游 __toolsnaps__ 生成的 131 个工具定义 + 26 个 toolset
  handlers/           14 个 handler 模块（index.js 负责合并与查重）
```

每个 handler 都是 `async (args, ctx) => plainObject`；`ctx` 提供 `client`、`config`、`log`、`signal`。
注册、schema、超时与渲染都在 `src/index.js`，handler 不接触宿主。详见
[`docs/HANDLER-CONTRACT.md`](docs/HANDLER-CONTRACT.md)。

## 开发

```bash
node scripts/generate.mjs   # 从 github-mcp-server 检出重新生成 src/generated/*
node scripts/verify.mjs     # 清单 + schema DSL + handler 覆盖率检查
node --test "tests/**/*.test.mjs"
GITHUB_TOKEN=… node scripts/smoke.mjs   # 只读工具的在线冒烟测试
```

## 保真度与限制

- **清单**：与上游 `__toolsnaps__` 一一对应（141 个快照 → 131 个唯一工具，多出的是同一工具的
  `*_output` 输出 schema 快照与特性开关变体）。
- **Schema**：`anyOf`/`$ref`/`$defs`/`minimum`/`maximum`/`minLength`/`x-mcp-header` 无法在宿主
  schema DSL 中表达，会被丢弃；可表达的部分（`type`、`oneOf`、`properties`、`required`、`items`、
  `enum`、`const`）完整保留。
- **输出**：不强制上游 `outputSchema`——插件声明 `output.schema = {type: 'json'}`。handler 返回 JSON
  值（对象，以及上游本身返回的数组或纯文本字符串），由渲染层格式化为缩进文本——模型读到的正是它。
- **权限**：不预检 token scope，由 GitHub 返回常规 403/404。
- **写操作**：与上游一致，写工具会真正修改数据。用 `readOnly: true` 或 `excludeTools` 限制会话。

### 有意偏差

每个工具调用的端点与参数都与上游一致；差异只在**渲染结果的外形**上，且均为有意为之：

| 偏差 | 位置 | 理由 |
| --- | --- | --- |
| 列表结果包成 `{items: [...], page, per_page}`（目录列举包成 `{directory: [...]}`），而非上游的裸数组 | `repos.js`、`issues.js`、`pull_requests.js` 的列表工具，以及 `get_file_contents` | 信封自带分页信息，在渲染文本中自解释；宿主并不强制输出 schema |
| `ui_get` 返回 `{method, <method>: <payload>}` | `context.js` | 与上游声明的 `UIGetOutput` 外形一致 |
| 上游以流式/重定向返回的辅助工具（workflow artifact、job logs、workflow-run log URL）只返回 API 端点 | `actions.js` | 宿主工具返回 JSON 而非二进制流；返回的端点会 302 到工件本身 |
| 受特性开关门控的分支（`ThreadResolutionReason`、`update_issue_suggestions`、MCP-App awaiting-form）不再门控 | `pull_requests.js`、`issues_granular.js` | 特性开关是上游服务端概念；这里一律开启 |
| 破坏性写操作前不做交互式确认（上游对 `delete_repository` 等会 elicitation） | `repos.js` | 本宿主没有 elicitation 通道；用 `readOnly: true` 兜底 |
| 项目条目标题由手写清洗器剥离 HTML，而非 HTML 分词器 | `governance.js`（`sanitizePlainText`） | 移植上游 `sanitize.PlainText`（去代码围栏信息串 + 剥标签 + 中性化尖括号）且不引新依赖；不像上游分词器那样解码 HTML 实体 |

未列出的部分均为对上游 Go handler 的忠实移植。

## Token 与密钥存储

**在把 token 填进任何地方之前请先读这一节。**

本插件不加密，harness 的插件配置层也不加密。`token` 字段就是一个普通 YAML 文件里的普通字符串：

```
$DSH_HOME/profiles/<profile>/cordis.patch.yml
  - id: github-tools
    config:
      token: ghp_xxxxxxxxxxxxxxxxxxxx        # ← 明文，就在这儿
```

这意味着：

- **能读这个文件的人就有你的 token。** Windows 上真正的保护是你用户目录的 ACL，而不是文件权限位
  （WSL 视角下 `/mnt/c` 恒为 `777`）。
- **该 profile 里的任何 agent 会话都能读到它。** agent 干活用的 shell / 文件工具同样能读 profile 补丁文档，
  被提示注入的 agent 不需要任何漏洞就能把它外传。
- **它会跟着走。** DSH 的配置备份与同步会带上 profile 文档，token 就跟着备份去了别处。
- **`redactSecrets` 帮不上忙。** harness 只在配置值**跨线边界**时剥离 `role('secret')` 字段，并回一个
  `{path, set}` 边车，好让远端界面渲染只写输入框而不收到值。那是传输边界控制，不是磁盘加密；没有任何东西
  对文件做脱敏。

### 该怎么办

三条路，前两条才是关键：

1. **用细粒度 token + 短过期。** 只授权你真正需要的仓库和权限，并设置过期（30–90 天）。细粒度 token 泄露
   是有边界的；带 `repo` + `workflow` 的 classic `ghp_` 泄露则不是。细粒度创建入口：
   <https://github.com/settings/personal-access-tokens/new>。配置页里给的链接预填的是 classic 表单和本插件
   用到的 scope —— 那是方便的选择，不是最安全的选择。
2. **别把 token 放进文件。** 让 `token` 留空，改用环境变量。解析顺序是 `config.token` → `config.tokenEnv`
   （默认 `GITHUB_PERSONAL_ACCESS_TOKEN`）→ `GITHUB_TOKEN` → `GH_TOKEN`，所以留空是完全受支持的配置。
   DSH 启动时会把 `$DSH_HOME/.env` 读进进程环境（`process.loadEnvFile`）：

   ```bash
   # $DSH_HOME/.env —— 已被 gitignore，且不属于 profile 的配置文档
   GITHUB_PERSONAL_ACCESS_TOKEN=github_pat_…
   ```

   这买到的是**分离**而不是加密：`.env` 本身也是明文。它避免的是 token 随每次配置备份、同步和 profile
   快照到处跑。
3. **或者用 loader 表达式让文件里没有字面量。** loader 接受配置值里的表达式，所以这样写是合法的：

   ```yaml
   - id: github-tools
     config:
       token: !!js process.env.GITHUB_PERSONAL_ACCESS_TOKEN
   ```

   代价：配置表单写入的是普通值，之后别再在 token 字段上点保存，否则表达式会被压回字面量。

### 插件做了什么

- GUI 里的 token 字段是**只写**控件：已存的 token 永不回显，空草稿不写入，所以保存其他字段不会清掉它。
- token 只发往你配置的 GitHub 主机，走 HTTPS 的 `Authorization` 头。不记日志，不收集遥测。
- 插件不预检 token scope，由 GitHub 返回 403/404。

## 许可

MIT
