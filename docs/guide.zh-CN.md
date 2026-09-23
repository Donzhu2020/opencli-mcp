# opencli-mcp 项目全览与使用指南（v0.0.1）

> 面向项目维护者和使用者的一份完整说明：这是什么、为什么这样设计、怎么装、怎么接、怎么用、怎么扩展、怎么排障、怎么开发和发版。模型（agent）看的文档在同目录的其它文件里（`instructions.md`、`api-use.md`、`api-reference.md` 等），本文不重复它们的措辞，只讲清楚整体。

## 1. 一句话

**opencli-mcp 是一个 MCP 原生的浏览器运行时**：由 Chrome 自己拉起的一个常驻进程（host）+ 一个 MV3 扩展，让任何 MCP 客户端（Claude Code、Cursor、Claude Desktop、云端 agent）通过一套对象模型操作你**已登录的真实 Chrome**，并把 agent 探索出来的流程固化成可复用的工具。

它只做两件事：

1. **像 Codex 一样逐步操作浏览器**：观察（可访问性快照）→ 行动（一次调用完成等待、定位、命中检测、真实输入、稳定）→ 断言 → 收尾。
2. **把探索过的流程固化成工具**：探索时写的 js 直接冻结，或从会话轨迹编译出带断言的函数，之后作为 `<site>_<command>` 工具复用。

浏览器操作通过 Chrome extension 执行，site adapters 使用本项目的 adapter SDK。

## 2. 为什么是常驻运行时，不是 CLI

一个 CLI 进程每次调用都是新进程：无法保持 debugger 附着、无法让快照里的 `eN` 引用跨调用存活、无法推送进度、无法返回图片、无法向用户提问。opencli-mcp 的 host 由 Chrome 通过 Native Messaging 拉起，寿命等于扩展的 Native 端口——端口开着，Chrome 就不会让扩展的 service worker 休眠——所以桥、端口、`chrome.debugger` 会话一起保持热态。

## 3. 架构

```
Chrome ──connectNative──► opencli-mcp host   （Native Messaging ⇄ 扩展；MCP over 本机回环 HTTP，bearer token）
                            │  runtime：会话 · site adapter registry· recon · 轨迹 · js 会话
本机 MCP 客户端 ──stdio──► `opencli-mcp` launcher ──► host（host 没起来时用内嵌 runtime）
云端 agent ──隧道/反代──► http://127.0.0.1:19991/mcp
```

四个部件：

| 部件 | 位置 | 职责 |
|---|---|---|
| **扩展**（MV3） | `extension/` | Native 端口；tab 租约（claim/finalize/组/徽章/光标）；`chrome.debugger` CDP（附着生命周期、对话框、console、网络、OOPIF）；页面侧引擎（Playwright injected script + `page.js` 页面模块，运行在隔离世界） |
| **host** | `src/host/` | 被 Chrome 拉起的 Native Messaging 进程；同时监听回环 HTTP 提供 MCP（Streamable HTTP + bearer token）；`setup`/`doctor`/状态文件 |
| **launcher** | `src/launcher/stdio.ts` | `opencli-mcp` 命令本身：stdio MCP，把请求代理到 host；host 不在时内嵌一个 runtime（只能跑 `public` 站点命令，不能浏览） |
| **runtime** | `src/runtime/`、`src/api/`、`src/mcp/`、`src/sites/`、`src/recon/` | 会话状态、对象模型（agent/browser/tab）、MCP server（工具/资源/prompt）、js 会话、站点注册表与执行器、定义/编译工具、API 发现 |

状态目录固定为 `~/.opencli-mcp/`：`token`（HTTP bearer）、`run/host.json`（运行中的 host）、`config.json`、`tools/<site>/<name>.js`（agent 定义的工具）、`bin/opencli-mcp-host`（Chrome 拉起的启动脚本）。没有环境变量覆盖，一件事一条路。

### 3.1 一个引擎

所有定位都走同一个引擎（`src/shared/engine.ts` + `extension/src/page/index.ts`，Playwright 的 InjectedScript 在扩展隔离世界里）：observe 的 `eN` 引用、`tab.find`、`tab.act`、站点适配器的 click/fill、固化工具的回放，用的是同一套 selector 语义（`internal:role/label/text/testid`、`aria-ref=eN`、css/Playwright selector、`within` 作用域、frame 链）。没有第二套 locator。

### 3.2 一个对象模型

模型侧只有一套 API（生成的参考在 `docs/api-reference.md`）：

- `agent.browsers.getDefault()` → `Browser`
- `browser.tabs.new/list/get/selected/finalize`、`browser.user.openTabs/claimTab`、`browser.nameSession`、`browser.capabilities`、`browser.documentation()`
- `tab.goto/url/title/back/forward/reload/close`、`tab.observe/screenshot/find/act/expect/evaluate`、`tab.dialog`、`tab.console`、`tab.network`、`tab.cookies`、`tab.fetchJson`、`tab.frames`、`tab.download`、`tab.webmcp`
- `sites.<site>.<command>(args)`、`sites.search/list/enable/disable/run`
- `recon.discover(tab)`
- `tools.define/compile/list/remove`
- `session.id/trace/clearTrace`

15 个入口工具只是它的投影。文档也是接口的一部分：第一次调 `js` 会附上 API 参考。

### 3.3 一个错误模型

所有路径（入口工具、js、站点命令）返回同一形状：`{ ok:false, error:{ code, message, hint?, ...data } }`。按 `code` 分支，不按文案。code 家族总表在 `docs/errors.md`（定位、可操作性、导航、frame、对话框、断言/固化、claim、授权、运行时）。

## 4. 安装

### 4.1 普通用户

需要 Node.js >= 22、Chrome 和一个 MCP client。

1. 从 [Chrome Web Store 安装 opencli-mcp 扩展](https://chromewebstore.google.com/detail/opencli-mcp/lnaoghmfcdnbhgcihkakfobckmfhllkg)。
2. 安装 npm 包并配置连接：

```bash
npm install -g opencli-mcp
opencli-mcp setup
```

保持 Chrome 打开。`setup` 配置浏览器连接，让你选择要配置的 MCP client，只注册所选的 Claude Code 或 Codex CLI，然后验证扩展是否连通。尚未安装扩展时，它会打开商店页面；已经连通时，不会重复打开。

### 4.2 开发与其他安装方式

源码开发、unpacked 扩展、Release tarball、自定义 browser profile 和更新步骤见 [安装与配置](setup.md)。

## 5. 接入 MCP client

- **Claude Code / Codex**：在 `setup` 中选择 `claude`、`codex` 或两者后注册；未选择的客户端不修改，已有配置会保留。
- **Cursor / Claude Desktop / 其他 MCP client**：在 `setup` 中选择 `manual`，把输出的配置复制到客户端 MCP 设置中。配置使用绝对路径，避免桌面应用找不到命令。
- 配置完成后，重启或重新连接 MCP client。

直接回车默认显示手动配置；选择 `none` 只配置浏览器连接。脚本可用 `--clients codex` 或 `--clients claude,codex` 指定客户端；非交互环境不带此参数时，不修改客户端设置。

不需要手动注册浏览器连接，也不需要填写 extension ID。重复运行 `setup` 可以修复浏览器注册、配置新安装的客户端；`doctor` 只检查连接，不修改配置。扩展会自动重连，持续连不上时再尝试停用并重新启用。

**云端 agent（Streamable HTTP）**：见 [远程连接](setup.md#remote-clients)。

**没有 Chrome 时**：stdio launcher 内嵌 runtime，`public` 站点命令可用，浏览类工具返回 `browser_unavailable`。

## 6. 使用方式

### 6.1 两种表面

| 表面 | 内容 | 适合 |
|---|---|---|
| **入口工具** | `doctor`、`tab_list`、`tab_open`（可命名会话）、`tab_claim`、`tab_release`、`tab_close`、`tab_observe`、`tab_read`、`tab_act`、`tab_expect`、`session_finalize`、`sites_search`、`site_run`、`tools_compile`、`tools_define`、`docs_list`、`docs_get`、`js`、`js_reset`；启用站点后动态出现 `<site>_<command>` | 一次结构化调用就够的核心循环 |
| **`js`** | 持久 JavaScript 会话，顶层 `const/let` 跨调用保留，最后一个表达式的值作为返回；全局有 `agent/sites/recon/tools/session/nodeRepl/Tab` | 批量多步、循环、条件、入口工具没有的能力（find、对话框、网络/console、cookies、frames、WebMCP、recon、关 tab 等） |

### 6.2 核心循环

```
tab_open（或 tab_claim）→ tab_observe → tab_act → tab_observe → … → tab_expect → session_finalize
```

- **observe**：操作地图，不是文档。Playwright 可访问性快照，节点带 `[ref=eN]`。默认是全量。只有还拿着上一份全量时才传 `diff:true`（`~` 变化、`+` 新增、`removed: e3–e5`）。`viewport:true` 只看视口内，不是全量的下一页。超长时带 ref 的分支标成 `(collapsed)`，再传 `{ref:"eN"}` 展开那一支。有 `Focused: [ref=eN]` 行；凭证字段值显示为 `<redacted>`。
- **read**：有界文档的线性正文，没有 ref。内部滚动以挂上懒加载，去重，然后把滚动位置还原。`reason:"unbounded"` 是没有底的信息流，已经返回的就是结果，不要再调一次去读完。
- **act**：一个 target + 一个 action。target 只能是一种定位：`{ref:"e12"}` | `{selector, nth?}` | `{role,name?}` | `{name}` | `{label}` | `{text}` | `{testid}` | `{x,y}`。`within` 和 `frame` 只缩小非坐标定位；`{x,y}` 不能带它们。`label` 和 `text` 不能同时给。action：click/dblclick/hover/focus/fill/type/press/select/check/uncheck/upload/drag/scroll/back/forward/reload。click 是真实鼠标事件，页面没收到就 `not_delivered`；只有这时才对同一目标用一次 `method:"dom"`（`HTMLElement.click()`，不发鼠标事件）。已经返回 ok 的点击不要再用 `method:"dom"` 重做。多个匹配只有一个可见才接受，否则 `selector_ambiguous`。
- **expect**：`{text|notText|url|title|selector|ref, visible?}` 轮询到超时；同时写进轨迹，成为固化工具的检查点。
- **finalize**：本回合最后一次浏览器动作。之后所有 Tab 句柄失效（`page_released`）。

### 6.3 js 示例

```js
const browser = await agent.browsers.getDefault();
await browser.nameSession('🔎 找资料');
const tab = await browser.tabs.new('https://news.ycombinator.com');
const s = await tab.observe();                                  // 快照 + eN
await tab.act({ target: { text: 'new' }, action: 'click' });
await tab.expect({ url: '/newest' });
const hits = await tab.find({ role: 'link', within: '#hnmain' , limit: 10 });
const titles = await tab.evaluate('[...document.querySelectorAll(".titleline a")].map(a => a.textContent)');
await browser.tabs.finalize();                                   // 关掉 agent 开的 tab
```

### 6.4 模型纪律（写进了 `api-use.md`）

locator 从最新 observe 构造，不猜；act 自身严格，不先 count、没有 nth/first 捷径；歧义就 `within` 或用 find 给的 `selector`；严格失败后重新 observe；稳定性顺序 testid > data-* > href > role+name > label > text > css > 坐标；通用标签（Close/Search/Add to cart）默认歧义必须 scoped；动作后只取最便宜的下一状态；不固定 sleep。

## 7. Tab 是用户的财产

- 第一个 tab 时命名会话（`tab_open {session}` / `browser.nameSession`）。agent 开的 tab 进入同名 Chrome tab 组，后台打开、静音，直到用户看它。
- **发现与 claim**：`tab_list {user:true, query:"…"}` 列出会话内 tab 和匹配的用户 tab；默认最多返回最近 20 个，可用 `limit` 调至 100。会话 tab 带 `origin`、`state`。`tab_claim` 按 `tabId`，或按 `url` 前缀 / `title` 子串唯一匹配；与 tabId 同时给时作为守卫，不匹配就失败，绝不悄悄换一个 tab。claim 来的 tab 不入组、不会被 finalize 关闭。
- **单独结束 tab**：`tab_release` 保留页面、释放控制权；agent 创建的 tab 还会离开分组并取消静音。`tab_close` 真正关闭页面，包括 claim 来的用户 tab。JavaScript API 对应 `tab.release()` / `tab.close()`。没有先 `tab_open` 或 `tab_claim`，浏览器操作不会暗中创建或接管 tab。
- **finalize**：`keep:[{tab, status:'deliverable'|'handoff'}]`。deliverable：离开组、留着；handoff：留在组里等下一回合，后续任何会话可从 `tab_list {user:true}` 再 claim 回来。其余 agent 开的 tab 关闭；返回的 `failed` 列出未成功清理、可重试的 tab。MCP 连接断开、session 关闭、空闲 1 小时，runtime 会替模型做同样的收尾。
- **光标**：光标覆盖层由 runtime 拥有，只在用户正看的 tab 显示，跨导航保持，离开会话即消失；未被观看的 tab 里动作不等光标动画。
- **debugger 附着**：整个会话保持，finalize 释放；用户在 Chrome 调试条取消后，下一次动作自动重附一次。
- 后台 tab 的输入延迟已通过焦点仿真解决；对话框（alert/confirm/prompt）会让命令返回 `dialog_open`，用 `tab.dialog.get/accept/dismiss` 处理。

## 8. 站点语料

内置 adapters 包含 Twitter/X（`twitter`）、Bilibili（`bilibili`）和 Reddit（`reddit`）。用 `sites_search` 查询当前命令及参数，按需启用为 tools：

- `sites_search` 按关键字/域名找；`site_run` 直接跑，不用启用；
- `sites.enable('x', {write?})`（js）把某站命令变成 `<x>_<command>` 工具（默认只读，`write:true` 加写命令），并发 tools/list_changed；
- adapters 使用 `@opencli-mcp/adapter-sdk` 的 `run({ tab, args, sites, recon })`，与 Agent 在 `js` 中使用同一个 Tab API。

## 9. 固化流程成工具

固化出来的工具与探索时是同一个对象模型：函数收到 `{ tab, args, sites, recon }`，`tab` 是绑定在工具自己后台页面上的普通 Tab。三种方式：

1. **直接冻结刚跑过的 js 函数**：`await tools.define({ site, name, description, access, args, func: async ({ tab, args }) => { … } })`，保存的是函数源码。
2. **从轨迹编译**：`tools_compile {site, name, description, inputs}`。网络优先（捕获到的 JSON 端点变成一条 `tab.fetchJson`），否则 `tab.goto` / `tab.act` / `tab.expect` 线性步骤。冻结的是**意图**（`role+name`、`label`、`text`、`testid`、你选的 `selector`、`within`），不是引擎解析出来的元素；对一次性 `eN` 或坐标的步骤会冻结回放 selector，并在 `warnings[]` 和 `// REVIEW` 注释里标出，结构性 css 也会告警。`inputs` 显式声明：`{query:"你输入的字面值"}` 或 `{query:{sample, description, type, mode:'exact'|'within'}}`，默认只替换完全相等的字面值。
3. **手写**：`tools_define` 给 `func` 源码。

每一步都被包裹：失败时 `error.details` 带 `step/label/state/expect/failed`，只修坏的那一步。工具文件在 `~/.opencli-mcp/adapters/<site>/<name>.js`，定义即生效（不用重启），启动时自动加载，`tools.list/remove` 管理。

## 10. recon：找页面背后的 API

`recon.discover(tab)`（js）收集页面加载的脚本，用 tree-sitter 做语法级分析（fetch/XHR/jQuery/axios/WebSocket/location，字符串拼接解析，未知部分标 `EXPR`），与捕获的网络请求合并成账本，排序：网络里见过 > API 形状的静态候选 > 其它。候选是证据不是合同，需验证鉴权/签名/分页后再用 `tab.fetchJson` 固化。

## 11. 配置与安全

`~/.opencli-mcp/config.json`：

```json
{
  "port": 19991,
  "cursor": true,
  "sites": ["twitter", "reddit"],
  "sitesWrite": []
}
```

- `sites`/`sitesWrite`：启动即启用的站点（只读 / 含写）。
- 云端接入靠 bearer token + 认证隧道；owner 已决定更细的安全设计后置。

## 12. 排障

- `browser_unavailable`：扩展没连上。跑 `doctor`：检查 Native Messaging 清单、扩展 ID、host 是否被 Chrome 拉起。
- 扩展改完没生效：Chrome 重启不刷新已解压扩展，要在扩展页"重新加载"再重启 host。
- `stale_page` / `page_released`：tab 已关或已 finalize 交还用户，重新 open/claim。
- `dialog_open`：先 `tab.dialog.get()` 再 accept/dismiss。
- `selector_ambiguous`：看候选，加 `within` 或用 find 的 `selector`。
- 更多见 `docs/errors.md`、`docs/troubleshooting.md`。

## 13. 仓库结构与开发

```
src/host        native-messaging、bridge、http（MCP 传输）、host 入口、setup、doctor、state
src/launcher    stdio launcher
src/runtime     会话、后端（extension-page）、轨迹
src/api         对象模型：api.ts（AgentApi）、browser.ts、tab.ts、context.ts、diff.ts、errors.ts
src/mcp         MCP server（工具/资源/prompt）、js 会话
src/sites       adapter 注册表、执行器、schema、define/compile
src/recon       analyzer（tree-sitter）、discover（账本）
src/shared      引擎（host 侧 selector 编译与 act 编排）、页面合同
src/docs        文档清单 → instructions / 资源
extension/src   background、sessions（租约/组/claim/finalize/光标）、cdp（附着/对话框/console/网络/OOPIF）、world、act、identity、page/（页面模块）、content/cursor
scripts/        构建（提取 Playwright injected、esbuild 扩展、生成 API 参考、拷贝资源）、smoke
docs/           模型侧文档、安装与开发指南
tests/          vitest（引擎、页面模块 jsdom、编译、文档/diff、js 会话、analyzer、native messaging、schema/registry）
```

开发命令：

```bash
npm run check            # 门禁：typecheck → build → test（每次提交前必须绿）
npm test                 # 只跑单测
npm run build:ext        # 只重建扩展
node scripts/smoke.mjs           # stdio 端到端（内嵌 runtime）
node scripts/smoke-browser.mjs   # 真 Chrome 端到端（经 Chrome 拉起的 host）
```

规则：`docs/api-reference.md` 由 `scripts/gen-api-reference.mjs` 从 TS 声明生成，不要手改；页面侧代码是真正的 TS 模块（`extension/src/page/index.ts`），有 jsdom 测试；消融即删除，不留开关；同一件事只有一条路。

发版流程：更新 npm `package.json` 版本（仅当 extension 改动时更新 `extension/manifest.json` 版本） → 更新 `CHANGELOG.md` → `npm run check` → `npm pack` → 在干净目录安装 tarball 验证 `version`/`doctor` → commit + `git tag -a vX` + push → `gh release create vX <tgz>`。npm 发布需要在本机 `npm login`。

## 14. 来源

- 部分 browser helpers 和 adapters 改编自 OpenCLI（源码保留 attribution），项目运行和开发不依赖 OpenCLI；定位引擎是 Playwright 的 injected script（Apache-2.0）；端点分析思路来自 jsluice（MIT）；交互与 tab 生命周期设计对照 ChatGPT/Codex Chrome 插件的机制学习而来。

许可证：Apache-2.0。
