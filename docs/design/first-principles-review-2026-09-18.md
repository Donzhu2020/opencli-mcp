# opencli-mcp 第一性原理复盘（2026-09-18，提交 8d8554b 时点）

作者：@opencli-mcp。对象：整个项目的架构与细节。方法：先从"产品只做两件事"推导应有的最小形状，再拿代码和 Codex 插件的实际做法逐项对照，只写有证据的判断。

## 0. 结论

骨架是对的：Codex 式对象模型、边缘原子 act、tab 是用户财产、文档即接口、Chrome 拉起的常驻 host。
但"一件事只走一条路"这个原则没有贯彻到底。owner 指出的"find 和 act 两套 locator"不是孤例，而是同一个系统性问题在四处重复：

| 一件事 | 现状 | 应有 |
|---|---|---|
| 与页面交互 | **三条路径**：agent 的 act（Playwright 注入引擎）；1206 条站点适配器和"固化"出来的工具走 OpenCLI `BasePage.click/fillText/setChecked`（指纹解析 + `el.click()` 兜底）；compile 还生成第三种 `locateJs` 打标签定位 | 一条：所有点击/输入都经过 act 引擎 |
| 观察页面 | **两套 ref 空间**：`dom` 源是 OpenCLI 快照（CLI 时代格式，`[N]` = `data-opencli-ref`），`aria` 源是 Playwright 快照（`eN`，和 act 同引擎），外加 `ax` 原始树 | 一套：aria 是唯一状态源与唯一 ref 空间 |
| 模型表面 | **两套**：40 个手写 typed tools + `js` 代码模式；Codex 只给模型 `js`（对象模型 + 文档），60 个内部命令不暴露 | 一套真源（对象模型），其余是投影 |
| 页面端代码 | 用模板字符串拼 JS（`engine.ts` 的 resolveJs/findJs/ariaSnapshotJs），测试者两次抓到 TDZ 和转义 bug | 真正的 TS 模块打包进 world，参数用 `Runtime.callFunctionOn` 传 |
| 子帧上下文 | 两套缓存：`cdp.ts` 的 `tabFrameContexts`（主 world）与 `world.ts` 的 `contexts`（引擎 world） | 一套 |

第二个结论：**"固化流程"只做到了雏形**。`compileFromTrace` 只会重放 goto/act 或直连抓到的 JSON 接口，没有断言、没有稳健的参数化、没有失败时的自修复，而且回放走的是另一条交互路径。它是产品的第二支柱，目前的完成度配不上"支柱"二字。

## 1. 从第一性原理推导：产品需要的最小机制

产品 = (a) 像 Codex 一样逐步操作浏览器 + (b) 把探索出来的流程固化成工具。为此必要且充分的机制只有五个：

1. **一个页面引擎**：定位（选择器/ref）、状态（可见/可用/可编辑/稳定）、输入（真实鼠标键盘）、观察（可 diff 的文本 + ref），所有 ref 在同一空间，所有调用者共用。
2. **一个会话/tab 模型**：会话 ⇄ tab 组，claim/finalize/handoff，人可见（光标、徽章、可见性）。
3. **一个模型表面**：对象模型 + 按需文档；任何工具只能是它的投影。
4. **一个固化机制**：把 trace 编译成"调用同一引擎的函数"，带参数、断言、验证。
5. **一个宿主拓扑**：常驻进程，被 Chrome 拉起，本机 stdio 与远端 HTTP 都能到。

对照之下，2 和 5 做到位了；1、3 各有"多条路"；4 只有雏形。

## 2. 逐项证据与整改

### 2.1 交互：三条路径 → 一条（P1）

- 证据：`node_modules/@jackwener/opencli/dist/src/browser/base-page.js:175` `click()` 走 `tryClickAxRef → runResolve（指纹）→ tryNativeClick → el.click()` 兜底；站点适配器通过 `IPage` 调它；`src/sites/define.ts:142` 编译出的工具也调 `page.click/fillText/setChecked`，语义定位时先 `page.evaluate(locateJs)` 打 `[data-opencli-compiled]`。
- 后果：agent 亲手做成功的操作，固化后可能失败（不同的可见性判定、不同的兜底）；两套错误码；两套要维护的 bug。
- 整改：`ExtensionPage` 覆盖 `click/fillText/typeText/setChecked/pressKey/selectOption`，一律委托 `act`（`{selector}` 或 `{css}`）；compile 直接输出 `page.act({...})`；删除对 OpenCLI 交互实现的依赖（`evaluate/fetchJson/goto/wait` 保留）。

### 2.2 观察：两套 ref → 一套（P1）

- 证据：`tab_observe` 默认 `source:'dom'`（`snapshotFormatter` + `data-opencli-ref`），`aria` 是后加的；`tab_find` 现在返回 `selector`，但 `ref` 仍是 `[N]`。Codex 只有一种状态：AX 树合成文本 + WASM diff。
- 整改：aria 成为唯一状态源（默认且唯一），`eN` 是唯一 ref；删除 `dom` 源、`snapshotFormatter`、`[N]` 标注、`scrollToRef` 等 CLI 时代快照链路；`ax` 原始树若无人用也删。diff 和 `viewport` 裁剪保留（Codex 有等价物）。截图保留。

### 2.3 模型表面：40 个工具 + js → 一个真源（P2）

- 证据：`src/mcp/server.ts` 手写 40 个 `registerTool`，schema 与对象模型多次漂移（claim、frame、find 的返回形状都是测试者对照后才一致）。Codex：模型只见 `js`（node REPL 上的对象模型）+ 文档，内部 60 个命令不是模型表面。
- 独立判断：不同 MCP 宿主对"代码工具"的接受度确实不同，但 Codex 已证明单 `js` 表面可行，而且我们已经有对象模型和文档机制。手写 40 个工具是在维护第二个 API。
- 整改（二选一，不留双路径）：A. 只保留 `js`、`docs_*`、`doctor` 与站点动态工具，其余删除；B. 从对象模型的类型声明自动生成 tab_*/session_* 投影（一处真源）。我倾向 A + 极少数入口工具（open/observe/act/finalize），因为投影生成器本身又是一个要维护的东西。

### 2.4 页面端代码：字符串模板 → 打包模块（P2）

- 证据：`src/shared/engine.ts` 367 行里 resolveJs/findJs/ariaSnapshotJs/settleJs/frameProbeJs 全是 `${}` 拼接的 JS；两次线上 bug（`const tag` TDZ、`\n`/`\d` 转义）都是这类；补救是用 vm + 桩 DOM 执行。
- 整改：页面端逻辑写成 `extension/src/page/*.ts` 真模块，esbuild 打成 world 脚本（和 Playwright 的 InjectedScript 一样），宿主用 `Runtime.callFunctionOn` 传结构化参数；测试用 vitest 的 browser mode 或 jsdom 直接跑模块。

### 2.5 固化流程：雏形 → 支柱（P2）

- 证据：`compileFromTrace` 两个分支：抓到 JSON 就直连 `fetchJson`（这是 OpenCLI 的精华，值得保留）；否则线性重放 goto/act 后 `wait 1s`，末尾返回整页快照。没有 `expect`，没有对输入的类型/校验，参数化靠样例值字符串替换。
- 整改：trace 里增加 agent 声明的断言（observe 后 `expect(text/url/ref state)`），compile 输出带断言的步骤；参数由 agent 显式声明而非猜；回放走 act 引擎（2.1 之后自然成立）；失败时返回结构化的"哪一步、什么断言、当前状态"，让 agent 能修。

### 2.6 会话与 tab：到位

claim/finalize/handoff、tab 组、静音、光标状态后台持有、徽章——与插件对齐，测试者在真实 Chrome 全量验证过。

### 2.7 宿主拓扑：正确但安装摩擦大（P3）

Chrome 拉起 host + Native Messaging + loopback HTTP + stdio 代理是对的（进程寿命 = 扩展端口寿命，无需自管端口）。代价是 NM manifest 要按浏览器/profile 安装（测试者需要 `--user-data-dir`），第一次用起来不顺。整改是 `install/doctor` 一次成功的工程，不是架构改动。

### 2.8 携带体积：`extension/src/cdp.ts` 1040 行（P3）

从 OpenCLI 扩展搬来的 network capture、file chooser、frame 目标、截图等。用得到，但 `tabFrameContexts`（主 world 上下文缓存）和 `world.ts contexts`（引擎 world）是两套帧上下文机制。整改：帧上下文只保留 world.ts 一套，`evaluateInFrame` 走它。

### 2.9 站点语料与 executor

1206 条命令是资产，不动。executor 的 strategy/pre-nav/siteSession 是 CLI 时代的执行模型，但只要它们跑在同一引擎上（2.1），不必现在重写。

### 2.10 安全

owner 明确后置。现有形状（origin approval、consequential confirm、loopback token）够用。

## 3. 优先级

1. P1 交互统一（2.1）与观察统一（2.2）——两者删掉的都是 CLI 时代的快照/点击链路，正是"消融"该删的。
2. P2 页面端代码模块化（2.4）、模型表面收敛（2.3）、固化流程加断言与参数（2.5）。
3. P3 帧上下文单轨（2.8）、安装一次成功（2.7）。

## 4. 自我批评

- 测试者报一个我修一个，没有回头看结构；"两套 locator"是系统性问题，我应该在设计阶段就用"每件事一条路"去核对，而不是等 owner 点出。
- 页面端代码没有执行测试就上线，出了两次同类 bug 才补 vm 测试；正确做法是一开始就不写字符串模板。
- 为了"完整可用"叠加了第二套模型表面（40 个工具），违背了自己设计文档里"code mode 单工具"的第一条。
