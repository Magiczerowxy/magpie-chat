# magpie-chat

**在 magpie 窗口里加一个「对话」页面。** 用 magpie 已经接好的模型、指令、技能和 MCP 服务器聊天，不用再开一个 Agent。

**A chat page inside magpie's window.** Talk with magpie's own models, instructions, skills and MCP servers — no second agent needed.

[![版本](https://img.shields.io/badge/version-0.1.19-blue)](https://github.com/Magiczerowxy/magpie-chat)
[![许可](https://img.shields.io/badge/license-MIT-green)](LICENSE)

---

## 中文

### 功能

- **一个页面**。装好后侧栏「插件」分组里出现「对话」。
- **用 magpie 的模型**。模型列表来自网关 `/v1/models`，切换即时生效；有推理档位的模型会给出对应的思考强度选项。
- **用 magpie 的配置**。右侧栏里勾选 `~/.config/magpie/library/` 的指令与技能（拼进 system prompt）、勾选 MCP 服务器（工具以 `tool_calls` 真正执行）。
- **多模态**。左下角「+」选图片或文件，也可以直接把文件拖进页面，或粘贴剪贴板里的图片。图片以 `image_url` 交给模型，气泡里显示缩略图、点开看大图。
- **流式输出**。思考过程边收边展开，输出结束后自动收起；正文逐字出现。
- **模型状态**。每条回复底部有一行：生成中显示「Magpie正在觅食ing… · 2s」并走计时；完成变绿「Magpie找到了食物！ · 2s」；出错变红「Magpie没有找到食物」（颜色平滑过渡）。耗时随对话保存，重新打开还能看到。
- **新对话草稿**。点「+」左侧立即出现一条「新对话」；发送第一条后标题换成你输入的内容；一个字没写就切到别的对话，这条草稿会自动消失，不留空壳。
- **公式**。`$…$`、`$$…$$`、`\(…\)`、`\[…\]` 由本地 KaTeX 渲染，随包打包，不连 CDN。
- **对话留存**。存在 magpie 配置目录的 `magpie-chat/conversations/`；每条可以置顶或删除。
- **和 magpie 同一个样子**。配色与字体取自 magpie 自己的设计令牌，切换主题时对话页跟着变。
- **可调布局**。右侧栏「布局」里两个滑条：会话区宽度（100% 即铺满，最窄 560px）、输入框宽度；还能打开「同步调整」让两者始终一致（调任一个另一个跟随，开启时取较小的那个统一）。左右两侧栏都能拖拽调宽、也都能收起。
- **代码折叠**。一条消息里有多段代码时只展开最后一段，其余收起。

### 截图

在 magpie 窗口里的一次真实对话：公式由本地 KaTeX 渲染，表格正常排版，右侧设置栏可以调会话区与输入框宽度。

![在 magpie 窗口里的对话](screenshots/23-math-and-layout.png)

### 安装

```powershell
magpie plugin add Magiczerowxy/magpie-chat
```

或者在应用里：**插件 → 发现 → 非官方插件 · GitHub**，搜索 `magpie-chat` 后点「安装」。

装好后侧栏「插件」里点「对话」即可。

### 安装时提示 403 / 证书错误

如果装的时候 `bun` 报这种错：

```
error: GET https://api.github.com/repos/.../tarball/ - 403
```

或者 `unable to get local issuer certificate`，多半是本机 `hosts` 被别的工具改过，把 GitHub 的域名指到了 `127.0.0.1`。常见来源是 Steam / Twitch 加速类工具（`steamcommunity_302` 之类）。

先查一下：

```powershell
findstr /i github C:\Windows\System32\drivers\etc\hosts
```

出现 `127.0.0.1 github.com` 这样的行就是它。三种办法：

1. 关掉那个加速工具（多数会自己还原 hosts）
2. 用管理员权限编辑 hosts，删掉所有含 `github` 的行，再 `ipconfig /flushdns`
3. 不折腾网络，把仓库下成文件夹直接装：`magpie plugin add "C:\path\to\magpie-chat"`

这不是插件的问题——在 hosts 正常的机器上 `magpie plugin add Magiczerowxy/magpie-chat` 可以直接装。

### 没有登录，也没有账号

这个插件**不注册供应商、不需要登录、不保存任何凭据**。它复用 magpie 自己已经配好的模型和额度，请求全部由 magpie 的网关发出，所以用量统计与故障切换和 Agent 一致。

它只保存你自己的东西，都在 magpie 配置目录下：

```
~/.config/magpie/magpie-chat/
├── settings.json      模型、思考强度、系统提示词、勾选的指令/技能/MCP、窗口布局
└── conversations/     每个对话一个 JSON
```

### 它怎么工作

magpie 的插件页面跑在 `sandbox="allow-scripts"` 的框架里：没有网络权限、不能内嵌框架、不能用存储，唯一允许的联网动作是把自身导航到别处。所以这个插件是两层的：

1. `page/index.html` 是 magpie 托管的「带路页」，读窗口主题后 `location.replace` 到本地服务。
2. `index.mjs` 作为 OpenCode v1 插件被 magpie 的 Bun 宿主加载，加载时启动那个本地服务（`127.0.0.1:3477`）。
3. `lib/server.mjs` 提供 `/api/*` 并把聊天请求转发给 magpie 网关；`chat/` 是真正的界面。

服务只监听回环地址，并拒绝非同源请求（只接受 opaque 的 `Origin: null` 与自身 origin），任意网页都无法借它消耗额度。

### 打不开怎么办
正常情况下装好、重启 magpie，打开「对话」就能用（干净环境实测 397ms 服务就绪）。

如果看到这个页面卡住或「127.0.0.1 拒绝连接」：

1. 先看 `magpie plugin` 的输出，有没有插件在反复报登录失败 / 401。
   宿主加载插件是排队走的，前面卡住会拖到后面的页面插件。
2. 把一直报错的插件停掉：`magpie plugin off <那个插件>`
3. 还不行就用独立启动兜底：双击插件目录里的 `start-server.cmd`
   （或 `start-server.vbs` 静默启动），再用 `install-autostart.cmd` 设成开机自启。

细节见 [SERVE.md](SERVE.md)。

### 已知限制

- MCP 实现了 Streamable HTTP 与 stdio，不含旧版 GET SSE 长连接与断线重连。
- 图片以 base64 内联发送，单图上限 24MB；对话很长时请求体也会变大。
- 供应商图标：magpie 的内置图标编在它自己的二进制里，取不到时服务端会画一个首字母 SVG。
- 工具调用最多 8 轮。
- 新对话草稿只存在内存里，刷新页面会消失（空白对话本来就不该留下）。
- 字号固定 13px，不跟随 magpie 的界面缩放。

---

## English

### What it does

- **One page.** Once installed, a **Chat** page appears under Plugins in the sidebar.
- **Uses magpie's own models.** The model list comes from the gateway's `/v1/models`; switching takes effect immediately, and models with reasoning levels get a thinking-effort picker.
- **Uses magpie's own library.** Tick instructions and skills from `~/.config/magpie/library/` (folded into the system prompt) and MCP servers (their tools run as real `tool_calls`).
- **Multimodal.** Pick images or files with the "+" button, drop files anywhere on the page, or paste an image. Images go to the model as `image_url`; thumbnails appear in the bubble and open full size.
- **Streaming.** Reasoning unfolds while it arrives and collapses automatically when the answer is done; the reply streams in.
- **Model status.** Every reply gets a line at its foot: while generating it reads "Magpie正在觅食ing… · 2s" with a running timer; on success it turns green ("Magpie找到了食物！ · 2s"); on failure it turns red ("Magpie没有找到食物") with a smooth colour transition. The elapsed time is saved with the conversation.
- **Draft conversations.** Clicking "+" puts a "新对话" row in the sidebar straight away; the title becomes what you typed as soon as you send. Switch away without writing anything and the draft disappears — no empty shells left behind.
- **Math.** `$…$`, `$$…$$`, `\(…\)` and `\[…\]` render through a bundled KaTeX — no CDN.
- **Conversations persist.** Stored under `magpie-chat/conversations/` in magpie's config directory; each can be pinned or deleted.
- **Looks like magpie.** Colors and fonts come from magpie's own design tokens, so the page follows the window theme.
- **Adjustable layout.** Two sliders under Layout: conversation width (100% fills the pane, never narrower than 560px) and composer width, plus a **Sync** switch that keeps the two equal (move either one, the other follows; turning it on adopts the smaller of the two). Both sidebars can be dragged and collapsed.
- **Collapsible code.** When a reply has several code blocks, only the last one is expanded.

### Screenshot

A real conversation inside magpie's window: math rendered by the bundled KaTeX, tables laid out normally, and the settings sidebar on the right for adjusting conversation and composer width.

![Chat inside magpie's window](screenshots/23-math-and-layout.png)

### Install

```powershell
magpie plugin add Magiczerowxy/magpie-chat
```

Or in the app: **Plugins → Discover → Unofficial · GitHub**, search `magpie-chat`, click Install.

Then open **Chat** under Plugins in the sidebar.

### If install fails with 403 / a certificate error

If `bun` reports something like:

```
error: GET https://api.github.com/repos/.../tarball/ - 403
```

or `unable to get local issuer certificate`, your machine's `hosts` file has probably been edited by a game/streaming accelerator (tools like `steamcommunity_302`) that points GitHub domains at `127.0.0.1`.

Check it:

```powershell
findstr /i github C:\Windows\System32\drivers\etc\hosts
```

If you see `127.0.0.1 github.com` lines, that's the cause. Either quit that tool (it usually restores the file), remove the `github` lines from `hosts` as administrator and run `ipconfig /flushdns`, or skip the network entirely and install from a folder: `magpie plugin add "C:\path\to\magpie-chat"`.

This is not a problem with the plugin — on a machine with a normal `hosts` file, `magpie plugin add Magiczerowxy/magpie-chat` installs fine.

### No sign-in, no account

This plugin **registers no provider, asks for no login, and stores no credentials**. It reuses whatever magpie itself is already signed in to; every request goes out through magpie's gateway, so usage and failover match the agent exactly.

What it does store is only yours, all under magpie's config directory:

```
~/.config/magpie/magpie-chat/
├── settings.json      model, effort, system prompt, ticked instructions/skills/MCP, layout
└── conversations/     one JSON per conversation
```

### How it works

magpie's plugin pages run in a `sandbox="allow-scripts"` frame: no network, no nested frames, no storage. The only way out is to navigate itself somewhere else. So this plugin is two layers:

1. `page/index.html` is a small launcher hosted by magpie; it reads the window theme and `location.replace`s to the local service.
2. `index.mjs` is loaded as an OpenCode v1 plugin by magpie's Bun host, and starts that local service (`127.0.0.1:3477`).
3. `lib/server.mjs` serves `/api/*` and forwards chat requests to magpie's gateway; `chat/` is the real UI.

The service binds loopback only and refuses any request whose Origin is neither opaque `null` (the sandboxed frame) nor its own, so no web page can borrow it to spend your quota.

### Known limits

- MCP covers Streamable HTTP and stdio; no legacy GET SSE stream or reconnect.
- Images are sent inline as base64, 24MB per image; long conversations make bigger requests.
- Provider icons live inside magpie's own binary; when one can't be read the server draws a letter badge.
- At most 8 tool-call rounds.
- Draft conversations live in memory only and are lost on reload (an empty conversation shouldn't linger anyway).
- Font size is fixed at 13px and does not follow magpie's UI zoom.

---

## 目录 / Layout

```
index.mjs            插件入口（启动本地服务） / plugin entry, starts the local service
page/                带路页，magpie 托管 / launcher page, hosted by magpie
chat/                对话界面 / the chat UI (index.html, app.js, style.css, vendor/katex)
lib/server.mjs       HTTP 路由、SSE、设置与对话持久化 / routes, SSE, settings, persistence
lib/gateway.mjs      magpie 网关客户端 / gateway client
lib/library.mjs      读取指令、技能、MCP 与供应商图标 / reads instructions, skills, MCP, icons
lib/mcp.mjs          MCP 客户端（Streamable HTTP + stdio）/ MCP client
assets/icon.svg      插件图标 / plugin icon
```

无需构建，仓库里的文件就是 magpie 加载的文件。
No build step: the files in this repo are exactly what magpie loads.

## 许可 / License

MIT
