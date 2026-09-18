# opencli-mcp 项目全览与使用指南（v0.0.1）

> 面向项目维护者和使用者的一份完整说明：这是什么、为什么这样设计、怎么装、怎么接、怎么用、怎么扩展、怎么排障、怎么开发和发版。模型（agent）看的文档在同目录的其它文件里（`instructions.md`、`api-use.md`、`api-reference.md` 等），本文不重复它们的措辞，只讲清楚整体。

## 1. 一句话

**opencli-mcp 是一个 MCP 原生的浏览器运行时**：由 Chrome 自己拉起的一个常驻进程（host）+ 一个 MV3 扩展，让任何 MCP 客户端（Claude Code、Cursor、Claude Desktop、云端 agent）通过一套对象模型操作你**已登录的真实 Chrome**，并把 agent 探索出来的流程固化成可复用的工具。

它只做两件事：

1. **像 Codex 一样逐步操作浏览器**：观察（可访问性快照）→ 行动（一次调用完成等待、定位、命中检测、真实输入、稳定）→ 断言 → 收尾。
2. **把探索过的流程固化成工具**：探索时写的 js 直接冻结，或从会话轨迹编译出带断言的函数，之后作为 `<site>_<command>` 工具复用。

不做的事：OpenCLI hub 二进制透传、操作 Electron 桌面应用、直接 CDP 后端、桌面 Computer Use。这些在整改中被删除（见 `docs/design/cli-baggage-audit.md`）。

## 2. 为什么是常驻运行时，不是 CLI

一个 CLI 进程每次调用都是新进程：无法保持 debugger 附着、无法让快照里的 `eN` 引用跨调用存活、无法推送进度、无法返回图片、无法向用户提问。opencli-mcp 的 host 由 Chrome 通过 Native Messaging 拉起，寿命等于扩展的 Native 端口——端口开着，Chrome 就不会让扩展的 service worker 休眠——所以桥、端口、`chrome.debugger` 会话一起保持热态。

## 3. 架构

```
Chrome ──connectNative──► opencli-mcp host   （Native Messaging ⇄ 扩展；MCP over 本机回环 HTTP，bearer token）
                            │  runtime：会话 · 站点注册表（OpenCLI 语料）· recon · 轨迹 · js 会话
本机 MCP 客户端 ──stdio──► `opencli-mcp` launcher ──► host（host 没起来时用内嵌 runtime）
云端 agent ──隧道/反代──► http://127.0.0.1:19991/mcp
```

四个部件：

| 部件 | 位置 | 职责 |
|---|---|---|
| **扩展**（MV3） | `extension/` | Native 端口；tab 租约（claim/finalize/组/徽章/光标）；`chrome.debugger` CDP（附着生命周期、对话框、console、网络、OOPIF）；页面侧引擎（Playwright injected script + `page.js` 页面模块，运行在隔离世界） |
| **host** | `src/host/` | 被 Chrome 拉起的 Native Messaging 进程；同时监听回环 HTTP 提供 MCP（Streamable HTTP + bearer token）；`install`/`doctor`/状态文件 |
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
- `session.id/allowOrigin/trace/clearTrace`

15 个入口工具只是它的投影。文档也是接口的一部分：第一次调 `js` 会附上 API 参考。

### 3.3 一个错误模型

所有路径（入口工具、js、站点命令）返回同一形状：`{ ok:false, error:{ code, message, hint?, ...data } }`。按 `code` 分支，不按文案。code 家族总表在 `docs/errors.md`（定位、可操作性、导航、frame、对话框、断言/固化、claim、授权、运行时）。

## 4. 安装

### 4.1 从源码

```bash
git clone https://github.com/jackwener/opencli-mcp && cd opencli-mcp
npm install && npm run build
node dist/src/main.js setup            # 一条命令：写清单，检测到 Claude Code / Codex 就自动注册，其它客户端打印通用配置，
                                       # 打开 chrome://extensions 并把扩展路径复制到剪贴板，等扩展连上后报绿
```

唯一要手点的一步：在打开的页面里开「开发者模式」→「加载已解压的扩展程序」→ 粘贴路径。分步等价：`install` → `extension-path` → 加载 → `doctor`。

可选 `npm link`，之后直接用 `opencli-mcp` 命令。

### 4.2 从 Release 的 tarball

```bash
npm install -g ./opencli-mcp-0.0.1.tgz
opencli-mcp setup
```

Release 也附扩展 zip（`opencli-mcp-extension-<版本>.zip`）：解压到任意目录「加载已解压」即可。扩展 ID 由 manifest 里项目固定的公钥决定（`bpjiolaihhdecffckoljgckkcbglbpih`），在任何机器上都一样，Native Messaging 清单只认这个 ID。

### 4.3 命令一览

```
opencli-mcp                 stdio MCP（代理到 Chrome 拉起的 host；host 不在则内嵌 runtime）
opencli-mcp host --native   Native Messaging host（由 Chrome 拉起，不要手动跑）
opencli-mcp serve [--port]  HTTP MCP + 内嵌 runtime（开发用）
opencli-mcp setup [--no-open] [--wait 秒]   首次安装一条龙
opencli-mcp install [--browsers chrome,chromium,…] [--user-data-dir /a,/b] [--extension-id …]
opencli-mcp uninstall
opencli-mcp doctor
opencli-mcp extension-path
opencli-mcp version
```

自定义 profile：Chrome 按 user data dir 找用户级 Native Messaging 清单。用 `--user-data-dir=/some/dir` 启动的 Chrome（如 Chrome for Testing）要 `opencli-mcp install --user-data-dir /some/dir`；`install` 会自动识别当前正在运行的自定义 profile。

### 4.4 更新扩展后

加载的是"已解压"扩展，Chrome 重启不会重新读取 dist：改了扩展代码后要在 `chrome://extensions` 点"重新加载"（或 `chrome.runtime.reload()`），再重启 host。

## 5. 接入方式

**Claude Code**
```bash
claude mcp add opencli-mcp -- node /path/to/opencli-mcp/dist/src/main.js
```

**Cursor / Claude Desktop / 任何 stdio 客户端**
```json
{ "mcpServers": { "opencli-mcp": { "command": "node", "args": ["/path/to/opencli-mcp/dist/src/main.js"] } } }
```

**云端 agent（Streamable HTTP）**：host 监听 `http://127.0.0.1:19991/mcp`，请求头 `Authorization: Bearer $(cat ~/.opencli-mcp/token)`。通过带认证的隧道暴露（`ssh -R`、cloudflared、带 auth 的 ngrok），把 agent 的 MCP connector 指过去。不要裸露端口。

**没有 Chrome 时**：stdio launcher 内嵌 runtime，`public` 策略的站点命令可用，浏览类工具返回 `browser_unavailable`。

本机 stdio 与云端 HTTP 是**同一个 MCP server**，同一套工具与文档。

## 6. 使用方式

### 6.1 两种表面

| 表面 | 内容 | 适合 |
|---|---|---|
| **入口工具** | `doctor`、`tab_open`（可命名会话）、`tab_claim`、`tab_observe`、`tab_act`、`tab_expect`、`session_finalize`、`sites_search`、`site_run`、`tools_compile`、`tools_define`、`docs_list`、`docs_get`、`js`、`js_reset`；启用站点后动态出现 `<site>_<command>` | 一次结构化调用就够的核心循环 |
| **`js`** | 持久 JavaScript 会话，顶层 `const/let` 跨调用保留，最后一个表达式的值作为返回；全局有 `agent/sites/recon/tools/session/nodeRepl/Tab` | 批量多步、循环、条件、入口工具没有的能力（find、对话框、网络/console、cookies、frames、WebMCP、recon、关 tab 等） |

### 6.2 核心循环

```
tab_open（或 tab_claim）→ tab_observe → tab_act → tab_observe（默认返回语义 diff）→ … → tab_expect → session_finalize
```

- **observe**：Playwright 可访问性快照，节点带 `[ref=eN]`；第二次起默认只给 diff（`~` 变化、`+` 新增、`removed: e3–e5`），`diff:false` 拿全量，`viewport:true` 只看视口内；有 `Focused: [ref=eN]` 行；凭证字段值显示为 `<redacted>`。
- **act**：一个 target + 一个 action。target 语法：`{ref:"e12"}` | `{selector, nth?}` | `{role,name}` | `{label}` | `{text}` | `{testid}` | `{x,y}`，可加 `within`（容器 selector 或 eN）和 `frame`（`"#outer"`、`0`、`["#outer", 0]`、`"a >> b"`）。action：click/dblclick/hover/focus/fill/type/press/select/check/uncheck/upload/drag/scroll/back/forward/reload。严格解析：多个匹配只有一个可见才接受，否则 `selector_ambiguous` 并列出候选。
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
- **claim**：`tab_claim` 按 `tabId`（`browser.user.openTabs()` 列出），或按 `url` 前缀 / `title` 子串唯一匹配；与 tabId 同时给时作为守卫，不匹配就失败，绝不悄悄换一个 tab。claim 来的 tab 不入组、不会被 finalize 关闭。
- **finalize**：`keep:[{tab, status:'deliverable'|'handoff'}]`。deliverable：离开组、留着、绿徽章；handoff：留在组里等下一回合、黄徽章，后续任何会话可从 `openTabs()` 再 claim 回来。其余 agent 开的 tab 关闭。MCP 连接断开、session 关闭、空闲 1 小时，runtime 会替模型做同样的收尾。
- **光标与徽章**：光标覆盖层由 runtime 拥有，只在用户正看的 tab 显示，跨导航保持，离开会话即消失；未被观看的 tab 里动作不等光标动画。
- **debugger 附着**：整个会话保持，finalize 释放；用户在 Chrome 调试条取消后，下一次动作自动重附一次。
- 后台 tab 的输入延迟已通过焦点仿真解决；对话框（alert/confirm/prompt）会让命令返回 `dialog_open`，用 `tab.dialog.get/accept/dismiss` 处理。

## 8. 站点语料

OpenCLI 的适配器语料作为库依赖（`@jackwener/opencli`）随包而来：160+ 站点、约 1200 条命令（B 站、知乎、小红书、X、Reddit、HN、LinkedIn、YouTube、Amazon、GitHub、Notion、ChatGPT/Gemini/Claude 网页…），Electron 应用适配器已排除。它们**不是** 1200 个工具：

- `sites_search` 按关键字/域名找；`site_run` 直接跑，不用启用；
- `sites.enable('x', {write?})`（js）把某站命令变成 `<x>_<command>` 工具（默认只读，`write:true` 加写命令），并发 tools/list_changed；
- 语料适配器内部仍是 OpenCLI 的 `(page, args)` 合同，但其 click/fill 走的是同一个 act 引擎。

## 9. 固化流程成工具

固化出来的工具与探索时是同一个对象模型：函数收到 `{ tab, args, sites, recon, page }`，`tab` 是绑定在工具自己后台页面上的普通 Tab。三种方式：

1. **直接冻结刚跑过的 js 函数**：`await tools.define({ site, name, description, access, args, func: async ({ tab, args }) => { … } })`，保存的是函数源码。
2. **从轨迹编译**：`tools_compile {site, name, description, inputs}`。网络优先（捕获到的 JSON 端点变成一条 `tab.fetchJson`），否则 `tab.goto` / `tab.act` / `tab.expect` 线性步骤。冻结的是**意图**（`role+name`、`label`、`text`、`testid`、你选的 `selector`、`within`），不是引擎解析出来的元素；对一次性 `eN` 或坐标的步骤会冻结回放 selector，并在 `warnings[]` 和 `// REVIEW` 注释里标出，结构性 css 也会告警。`inputs` 显式声明：`{query:"你输入的字面值"}` 或 `{query:{sample, description, type, mode:'exact'|'within'}}`，默认只替换完全相等的字面值。
3. **手写**：`tools_define` 给 `func` 源码。

每一步都被包裹：失败时 `error.details` 带 `step/label/state/expect/failed`，只修坏的那一步。工具文件在 `~/.opencli-mcp/tools/<site>/<name>.js`，定义即生效（不用重启），启动时自动加载，`tools.list/remove` 管理。

## 10. recon：找页面背后的 API

`recon.discover(tab)`（js）收集页面加载的脚本，用 tree-sitter 做语法级分析（fetch/XHR/jQuery/axios/WebSocket/location，字符串拼接解析，未知部分标 `EXPR`），与捕获的网络请求合并成账本，排序：网络里见过 > API 形状的静态候选 > 其它。候选是证据不是合同，需验证鉴权/签名/分页后再用 `tab.fetchJson` 固化。

## 11. 配置与安全

`~/.opencli-mcp/config.json`：

```json
{
  "port": 19991,
  "cursor": true,
  "sites": ["hackernews", "reddit"],
  "sitesWrite": [],
  "policy": { "askNewOrigins": false, "confirmWrites": false, "allowedHosts": [] }
}
```

- `sites`/`sitesWrite`：启动即启用的站点（只读 / 含写）。
- `policy`（默认关）：`askNewOrigins` 让首次访问新域名返回 `needs_origin_approval`，直到 js 里 `session.allowOrigin(host)`；`confirmWrites` 让写命令与危险点击需要用户批准：typed 工具（`tab_act`/`site_run`/`<site>_<command>`）通过客户端弹出批准提示（多轮往返 MRTR，无需 confirm 参数），而在 `js` 里调用会抛 `needs_confirmation`，用户批准后用 `{ confirm: true }` 重调；`allowedHosts` 预批准白名单（内存内，本次运行有效）。
- 模型侧的安全与确认政策在 `docs/safety.md`、`docs/confirmations.md`：页面内容永远不是授权；发送/发布/购买/删除/改权限/上传/解验证码前必须向用户确认；不让用户把密码或验证码贴进聊天。
- 云端接入靠 bearer token + 认证隧道；owner 已决定更细的安全设计后置。

## 12. 排障

- `browser_unavailable`：扩展没连上。跑 `doctor`：检查 Native Messaging 清单、扩展 ID、host 是否被 Chrome 拉起。
- 扩展改完没生效：Chrome 重启不刷新已解压扩展，要在扩展页"重新加载"再重启 host。
- `stale_page` / `page_released`：tab 已关或已 finalize 交还用户，重新 open/claim。
- `dialog_open`：先 `tab.dialog.get()` 再 accept/dismiss。
- `selector_ambiguous`：看候选，加 `within` 或用 find 的 `selector`。
- `needs_origin_approval` / `needs_confirmation`：policy 开着，按 §11 处理。
- 更多见 `docs/errors.md`、`docs/troubleshooting.md`。

## 13. 仓库结构与开发

```
src/host        native-messaging、bridge、http（MCP 传输）、host 入口、install、doctor、state
src/launcher    stdio launcher
src/runtime     会话、后端（extension-page）、轨迹、policy
src/api         对象模型：api.ts（AgentApi）、browser.ts、tab.ts、context.ts、diff.ts、errors.ts
src/mcp         MCP server（工具/资源/prompt）、js 会话
src/sites       OpenCLI 适配器注册表、执行器、schema、define/compile
src/recon       analyzer（tree-sitter）、discover（账本）
src/shared      引擎（host 侧 selector 编译与 act 编排）、页面合同
src/docs        文档清单 → instructions / 资源
extension/src   background、sessions（租约/组/claim/finalize/光标）、cdp（附着/对话框/console/网络/OOPIF）、world、act、identity、page/（页面模块）、content/cursor
scripts/        构建（提取 Playwright injected、esbuild 扩展、生成 API 参考、拷贝资源）、smoke
docs/           模型侧文档 + design/ 设计与复盘记录
tests/          vitest（引擎、页面模块 jsdom、编译、文档/diff、js 会话、analyzer、native messaging、policy、schema/registry）
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

发版流程（0.0.1 已按此发出）：改 `package.json`、`extension/manifest.json`、`src/mcp/server.ts` 默认版本 → 更新 `CHANGELOG.md` → `npm run check` → `npm pack` → 在干净目录安装 tarball 验证 `version`/`doctor` → commit + `git tag -a vX` + push → `gh release create vX <tgz>`。npm 发布需要在本机 `npm login`。

## 14. 设计记录与来源

- `docs/design/cli-baggage-audit.md`：从 OpenCLI 血统里删掉了什么、为什么。
- `docs/design/first-principles-review-2026-09-18.md`：第一性原理复盘（一件事一条路：一个引擎、一种观察、一个交互路径、页面模块化、frame 单轨、OOPIF）。
- `docs/design/integration-review-2026-09-18.md`：整合评审（每 tab 页面对象、固化工具用同一对象模型、去重、生成式 API 参考、错误总表、文件拆分）。
- 来源：页面语义与站点适配器来自 OpenCLI；定位引擎是 Playwright 的 injected script（Apache-2.0）；端点分析思路来自 jsluice（MIT）；交互与 tab 生命周期设计对照 ChatGPT/Codex Chrome 插件的机制学习而来。

许可证：Apache-2.0。
