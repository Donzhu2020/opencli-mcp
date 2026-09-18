# opencli-mcp 整合评审（2026-09-18，接第一性原理复盘之后）

问题不再是"一件事走了几条路"，而是"各部分是否结合成一个完整、优雅的方案"。判断标准：agent 从探索到固化到复用，是否只学一套对象模型、只经历一种状态、只遇到一种错误；运行时内部是否没有为了迁就旧模型而保留的中间层。

## 发现

| # | 现状 | 为什么不优雅 | 改法 |
|---|---|---|---|
| A | 固化出来的工具签名是 OpenCLI 适配器的 `async (page, args)`，`page` 是 IPage 方言（`page.act/aria/expect/goto/fetchJson`），而 agent 探索时用的是 `tab.*` 对象模型；`tools.compile` 从 trace 重新推导代码 | 探索和固化是两种语言；agent 在 js 里写好的代码不能直接冻结 | 固化工具接收探索时同一个对象模型：`async ({ tab, args, sites, recon }) => …`；compile 直接生成 `tab.goto/act/expect/observe`；`tools.define` 接受函数值（源码由 `toString` 持久化）；OpenCLI 语料适配器保留 IPage 内部合同不受影响 |
| B | 每个 MCP 会话只有一个共享 page 对象，`Tab.use()` 在会话级锁下切换"当前活动 tab 身份"再发命令 | 这是 OpenCLI"一进程一页面"时代的产物：串行化所有 tab 操作、可变的隐式当前身份、`getActivePage/setActivePage` 到处传播 | 每个 Tab 绑定自己的 page 对象（同一 bridge 上的轻量实例，命令自带 `page` 身份），锁变为每 tab 串行，会话级锁与活动身份切换删除 |
| C | 对象模型里的重复表达：`tab.wait` 与 `tab.expect`；target 的 `css` 与 `selector`；`session.name/finalize` 与 `browser.nameSession/tabs.finalize` | 同一件事两个名字，文档和心智都要维护两份 | 删 `wait`（`expect` 覆盖，固定睡眠本就不鼓励）；模型语法只留 `selector`（`css` 仅作适配器内部输入）；`session.*` 只留 id/allowOrigin/trace |
| D | js 的 API 文档是手写散文（js-tool.md），Codex 给模型的是从类型生成的接口参考 | 手写会漂移——这正是 40 个手写工具当初的病 | 从 `src/api` 的 TypeScript 声明生成 `docs/api-reference.md`，构建时产出，`documentation()` 与首次 `js` 调用附带 |
| E | 错误模型：50 余个 code 分散在 host/extension，语义一致但没有一处总表 | 模型只能靠零散文档猜 | 在 api-use 里给出 code 家族总表（定位/状态/导航/frame/对话框/固化/授权），并保证所有路径经 `ActionError.toJSON` 同一形状（已成立） |
| F | 本机 stdio 与云端 HTTP 是同一 MCP 服务器；嵌入模式（无 Chrome）行为不同但已文档化 | — | 不改 |
| G | `src/api/agent.ts` 440 行合并了 Tab/Browser/sites 代理/工厂 | 可读性 | 拆为 tab.ts / browser.ts / api.ts（不改行为） |

## 顺序
B（每 tab 页面对象）→ A（固化工具用同一对象模型）→ C（去重）→ D（生成式 API 参考）→ E（错误总表）→ G（拆文件）。每步一个提交、`npm run check` 门禁、交 @mcp测试 真机验证。
