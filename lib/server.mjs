// magpie-chat 的服务：给窗口里的对话页提供 /api/*，并把聊天请求转给 magpie 网关。
// 只用内置模块，不装依赖。

import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { composeSystem, configDir, groupIcons, libraryView, providerIcons, readJson, readMcp, readProviderIcon } from "./library.mjs";
import { chatCompletions, gatewayURL, listModels, resolveGateway, sseChunks } from "./gateway.mjs";
import { callTool, closeAll, listTools } from "./mcp.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const UI_ROOT = join(here, "..", "chat");
const MAX_TOOL_ROUNDS = 8;

// 插件版本，从包里的 package.json 读（别在两处写死同一个数字）
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version || "";
  } catch {
    return "";
  }
})();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

// ---- 设置与对话：存在 magpie 配置目录下，跟插件自己的数据放一起 ----
function dataDir(configDirPath) {
  const dir = join(configDirPath || configDir(), "magpie-chat");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// 从 magpie 的 settings.json 读用户设的字体，拼成覆盖 :root 的 CSS。
// 没设就返回空串，页面用自己的兜底字体栈。
async function fontCss() {
  const UI_FALLBACK = '-apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif';
  const CODE_FALLBACK = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  const quote = (s) => '"' + String(s).replace(/["\\\x00-\x1f]/g, "") + '"';
  const parts = [];
  try {
    const s = JSON.parse(await readFile(join(configDir(), "settings.json"), "utf8"));
    const has = (f) => f && typeof f.family === "string" && f.family.trim();
    if (has(s.uiFont)) {
      const f = s.uiFont;
      // 字体名后面接 magpie 自己的基础栈：找不到那个字体时逐级回落
      parts.push(`--font: ${quote(f.family)}, ${UI_FALLBACK};`);
      if (Number.isFinite(f.weight) && f.weight >= 1 && f.weight <= 1000) parts.push(`--font-weight: ${f.weight};`);
      if (["normal", "italic", "oblique"].includes(f.style)) parts.push(`--font-style: ${f.style};`);
      if (Number.isFinite(f.stretch) && f.stretch > 0) parts.push(`--font-stretch: ${f.stretch}%;`);
    }
    if (has(s.codeFont)) {
      const c = s.codeFont;
      parts.push(`--code: ${quote(c.family)}, ${CODE_FALLBACK};`);
      if (Number.isFinite(c.weight) && c.weight >= 1 && c.weight <= 1000) parts.push(`--code-weight: ${c.weight};`);
    }
  } catch {
    return ""; // 读不到设置就用页面自己的兜底
  }
  return parts.length ? `:root { ${parts.join(" ")} }` : "";
}

const DEFAULTS = {
  model: "", effort: "", system: "", instructions: [], skills: [], mcp: [],
  temperature: 0.7, maxTokens: 0, showReasoning: true,
  pinned: [],       // 置顶的对话 id，按置顶顺序排在列表最前
  sidebar: true,    // 左侧栏是否展开
  settingsOpen: false, // 右侧设置栏是否打开
  leftWidth: 0,     // 左侧栏宽度（0 = 用默认值）
  rightWidth: 0,    // 设置栏宽度（0 = 用默认值）
  convWidth: 72,    // 会话内容列宽度（%），100 = 铺满
  composerWidth: 70, // 输入框宽度（%）
  syncWidth: false, // 布局里的"同步调整"：打开后两个宽度始终一致
};

function cleanSettings(raw) {
  const s = { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  return {
    model: String(s.model || ""),
    effort: String(s.effort || ""),
    system: String(s.system || ""),
    instructions: Array.isArray(s.instructions) ? s.instructions.map(String) : [],
    skills: Array.isArray(s.skills) ? s.skills.map(String) : [],
    mcp: Array.isArray(s.mcp) ? s.mcp.map(String) : [],
    temperature: Number.isFinite(Number(s.temperature)) ? Number(s.temperature) : 0.7,
    maxTokens: Number.isFinite(Number(s.maxTokens)) ? Number(s.maxTokens) : 0,
    showReasoning: s.showReasoning !== false,
    pinned: Array.isArray(s.pinned) ? s.pinned.map(String).filter(Boolean).slice(0, 200) : [],
    sidebar: s.sidebar !== false,
    settingsOpen: s.settingsOpen === true,
    leftWidth: Number.isFinite(Number(s.leftWidth)) ? Math.max(0, Math.min(420, Number(s.leftWidth))) : 0,
    rightWidth: Number.isFinite(Number(s.rightWidth)) ? Math.max(0, Math.min(560, Number(s.rightWidth))) : 0,
    convWidth: Number.isFinite(Number(s.convWidth)) ? Math.max(0, Math.min(100, Number(s.convWidth))) : 72,
    composerWidth: Number.isFinite(Number(s.composerWidth)) ? Math.max(35, Math.min(100, Number(s.composerWidth))) : 70,
    syncWidth: s.syncWidth === true,
  };
}

export function createStore(configDirPath) {
  const dir = dataDir(configDirPath);
  const settingsPath = join(dir, "settings.json");
  const convDir = join(dir, "conversations");
  if (!existsSync(convDir)) mkdirSync(convDir, { recursive: true });

  const store = {
    dir,
    async settings() {
      return cleanSettings(await readJson(settingsPath, {}));
    },
    async saveSettings(patch) {
      const next = cleanSettings({ ...(await store.settings()), ...(patch || {}) });
      await writeFile(settingsPath, JSON.stringify(next, null, 2));
      return next;
    },
    convPath(id) {
      const safe = String(id || "").replace(/[^\w-]/g, "").slice(0, 64);
      return safe ? join(convDir, safe + ".json") : "";
    },
    async getConversation(id) {
      const p = store.convPath(id);
      if (!p) return null;
      return readJson(p, null);
    },
    async saveConversation(conv) {
      const id = conv.id || "c_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      const messages = Array.isArray(conv.messages) ? conv.messages.slice(-400) : [];
      const title = String(conv.title || firstLine(messages) || "新对话").slice(0, 90);
      const out = { id, title, updated: Date.now(), messages };
      const p = store.convPath(id);
      if (!p) throw new Error("bad conversation id");
      await writeFile(p, JSON.stringify(out));
      return out;
    },
    async listConversations() {
      const { readdir } = await import("node:fs/promises");
      const names = await readdir(convDir).catch(() => []);
      const items = [];
      for (const n of names) {
        if (!n.endsWith(".json")) continue;
        const c = await readJson(join(convDir, n), null);
        if (!c?.id) continue;
        const last = [...(c.messages || [])].reverse().find((m) => m.role === "user");
        items.push({ id: c.id, title: c.title, updated: c.updated || 0, preview: String(last?.content || "").slice(0, 120) });
      }
      // 置顶的排在前面（按置顶顺序），其余按最近更新
      const pinned = (await store.settings()).pinned || [];
      const rank = new Map(pinned.map((id, i) => [id, i]));
      return items.sort((a, b) => {
        const ra = rank.has(a.id) ? rank.get(a.id) : -1;
        const rb = rank.has(b.id) ? rank.get(b.id) : -1;
        if (ra >= 0 && rb >= 0) return ra - rb;
        if (ra >= 0) return -1;
        if (rb >= 0) return 1;
        return b.updated - a.updated;
      }).map((item) => ({ ...item, pinned: rank.has(item.id) }));
    },
    async removeConversation(id) {
      const { rm } = await import("node:fs/promises");
      const p = store.convPath(id);
      if (p) await rm(p, { force: true });
    },
  };
  return store;
}

// 没有图标文件时生成的首字母徽章：颜色按名字散列，同一供应商总是同一色
function letterIcon(name) {
  const s = String(name || "?");
  let hue = 0;
  for (let i = 0; i < s.length; i++) hue = (hue * 31 + s.charCodeAt(i)) % 360;
  const ch = s.slice(0, 1).toUpperCase().replace(/[<&>"]/g, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
<rect width="32" height="32" rx="7" fill="hsl(${hue}, 52%, 88%)"/>
<text x="16" y="16" text-anchor="middle" dominant-baseline="central"
      font-family="-apple-system, Segoe UI, sans-serif" font-size="16" font-weight="600"
      fill="hsl(${hue}, 52%, 30%)">${ch}</text></svg>`;
}

function firstLine(messages) {
  const u = (messages || []).find((m) => m.role === "user");
  const text = String(u?.content || "").trim().replace(/\s+/g, " ");
  return text.slice(0, 60);
}

// ---- HTTP ----
// magpie 的插件页面跑在 sandbox="allow-scripts" 的框架里，origin 是 opaque，
// 浏览器发来的 Origin 就是字面量 "null"。直接在地址栏打开同一个服务时，Origin 是本服务自己。
// 其他来源一律拒绝：这个服务能替用户烧额度，不能给任意网页用。
let OWN = new Set();

function originAllowed(req) {
  const o = req.headers.origin;
  return o === undefined || o === "null" || OWN.has(o);
}

function corsHeaders(req) {
  const o = req.headers?.origin;
  const allow = o === "null" ? "null" : o && OWN.has(o) ? o : "null";
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-headers": "content-type",
    // 必须列全：浏览器对 PATCH 这类非简单方法会先发 OPTIONS 预检，
    // 这里没列出来的方法，预检就过不去，前端只会看到 "Failed to fetch"。
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    vary: "Origin",
  };
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  const data = typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    ...corsHeaders(res.req),
    "x-content-type-options": "nosniff",
  });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 24 * 1024 * 1024) throw new Error("请求太大");
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("请求不是合法的 JSON");
  }
}

function sseHead(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    ...corsHeaders(res.req),
    "x-accel-buffering": "no",
  });
  res.flushHeaders?.();
}

function sse(res, type, data) {
  if (res.writableEnded) return;
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

// system prompt 之外，把 MCP 工具的用途也告诉模型（工具本身用 function calling 给）
// 工具清单写在 system 里会和 function 定义重复一遍，所以只给一句交代。
function toolsHint(tools) {
  if (!tools.length) return "";
  return `# 工具\n\n你可以调用用户配置的 MCP 工具（共 ${tools.length} 个）。需要时直接调用，不要臆造结果；用不上就直接回答。`;
}

// 工具的 schema 是提示词里最大的一块：GitHub 那 46 个工具光描述和参数就有上千万字符。
// 只留名字、第一行说明，参数表裁到前 8 个字段、每个字段只留类型和一句说明。
const MAX_PROPS = 8;
function slimSchema(schema) {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
  const out = { type: "object", properties: {} };
  const props = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  for (const [key, val] of Object.entries(props).slice(0, MAX_PROPS)) {
    if (!val || typeof val !== "object") { out.properties[key] = { type: "string" }; continue; }
    const slim = { type: val.type || "string" };
    if (val.description) slim.description = String(val.description).split("\n")[0].slice(0, 120);
    if (Array.isArray(val.enum)) slim.enum = val.enum.slice(0, 20);
    if (val.type === "array" && val.items?.type) slim.items = { type: val.items.type };
    out.properties[key] = slim;
  }
  if (Array.isArray(schema.required) && schema.required.length) out.required = schema.required.slice(0, MAX_PROPS);
  return out;
}

function toFunctionTools(tools) {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: (t.description || "").split("\n")[0].slice(0, 200) || t.name,
      parameters: slimSchema(t.inputSchema),
    },
  }));
}

// 一条消息转成网关认的 content：
// 没有图片就是字符串；有图片就变成 [{type:"text"},{type:"image_url",image_url:{url}}]
// （image_url 收 data: URL，magpie 网关会原样转给上游）。
function toGatewayContent(m) {
  const text = String(m.content ?? "");
  const files = Array.isArray(m.files) ? m.files : [];
  const images = files.filter((f) => f && f.kind === "image" && f.data);
  if (!images.length) return text;
  const parts = [];
  if (text.trim()) parts.push({ type: "text", text });
  for (const img of images) {
    parts.push({ type: "image_url", image_url: { url: String(img.data) } });
  }
  // 非图片附件以文字交代给模型，避免它不知道用户放了文件
  const others = files.filter((f) => f && f.kind !== "image");
  if (others.length) {
    parts.push({ type: "text", text: others.map((f) => `[附件] ${f.name || "文件"}（${f.size || 0} 字节）`).join("\n") });
  }
  return parts;
}

// 一轮对话：可多次工具调用；把每条增量转成 SSE 发回浏览器
async function runChat({ res, body, settings, store }, controllers) {
  const clientId = String(body.clientId || "");
  const abort = new AbortController();
  if (clientId) controllers.set(clientId, abort);
  res.on("close", () => { if (!res.writableEnded) abort.abort(); });

  const started = Date.now();
  const model = String(body.model || settings.model || "");
  const effort = String(body.effort ?? settings.effort ?? "");
  const temperature = Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : settings.temperature;
  const maxTokens = Number.isFinite(Number(body.maxTokens)) ? Number(body.maxTokens) : settings.maxTokens;
  const wantTools = body.useTools !== false && (settings.mcp || []).length > 0;

  const history = Array.isArray(body.messages) ? body.messages.filter((m) => m && (m.role === "user" || m.role === "assistant")) : [];
  // 只挂了图片/文件、没写文字的消息也算有内容
  const hasContent = history.some((m) => String(m.content ?? "").trim() || (Array.isArray(m.files) && m.files.length));
  if (!model) { sse(res, "error", { message: "没有选模型：在右下角挑一个 magpie 的模型" }); res.end(); return; }
  if (!history.length || !hasContent) { sse(res, "error", { message: "没有内容可发送" }); res.end(); return; }

  // 工具：只把跟这轮问题相关的交出去。
  // GitHub 一个服务器就有 46 个工具，全塞给模型时提示词会涨到上千万 token：
  // 又慢又贵，模型还会被工具说明淹掉、几乎不产出正文。所以按问题里的词筛，
  // 没筛出相关的就只留最通用的几个，宁可少给也不要全给。
  let tools = [];
  let toolNote = "";
  if (wantTools) {
    const servers = await readMcp();
    const picked = servers.filter((s) => (settings.mcp || []).includes(s.name));
    const all = [];
    for (const s of picked) {
      try {
        const list = await listTools(s);
        for (const t of list) all.push({ ...t, server: s.name, name: s.name + "_" + t.name.replace(/[^\w-]/g, "_"), rawName: t.name });
      } catch (err) {
        sse(res, "tool", { phase: "error", name: s.name, result: "无法连接 " + s.name + "：" + (err?.message || err) });
      }
    }
    const q = String(history[history.length - 1]?.content || "").toLowerCase();
    const words = q.split(/[^a-z0-9\u4e00-\u9fff]+/).filter((w) => w.length >= 3);
    const scored = all.map((t) => {
      const hay = (t.name + " " + (t.description || "")).toLowerCase();
      let score = 0;
      for (const w of words) if (hay.includes(w)) score += w.length > 4 ? 2 : 1;
      return { t, score };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
    const MAX_TOOLS = 12;
    tools = scored.slice(0, MAX_TOOLS).map((x) => x.t);
    if (tools.length < 3) {
      // 问得太笼统时给一组最通用的，但仍然封顶
      const common = /^(get|list|search|read|fetch|query)_|(_search|_list|_get)$/;
      const extra = all.filter((t) => common.test(t.rawName) && !tools.includes(t)).slice(0, 8);
      tools = tools.concat(extra).slice(0, MAX_TOOLS);
    }
    if (all.length > tools.length) {
      toolNote = `（这次提供了 ${tools.length}/${all.length} 个工具：按你的问题挑的）`;
    }
  }

  const system = [await composeSystem(settings), toolsHint(tools)].filter(Boolean).join("\n\n");
  if (toolNote) sse(res, "tool", { phase: "note", name: "tools", result: toolNote });
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  for (const m of history) {
    const calls = m.role === "assistant" && Array.isArray(m.toolCalls) ? m.toolCalls.filter((c) => c && c.name) : [];
    if (!calls.length) {
      messages.push({ role: m.role, content: toGatewayContent(m) });
      continue;
    }
    // 一轮工具调用的完整重放：assistant.tool_calls 后面必须跟每个调用的 tool 结果，
    // 少一条网关就拒收，所以没有结果的调用不放进历史。
    const done = calls.filter((c) => String(c.result ?? "") !== "" || c.isError);
    if (!done.length) {
      if (m.content) messages.push({ role: "assistant", content: String(m.content) });
      continue;
    }
    messages.push({
      role: "assistant",
      content: m.content || "",
      tool_calls: done.map((c, i) => ({
        id: String(c.id || `history_${i}`),
        type: "function",
        function: { name: String(c.name), arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args || {}) },
      })),
    });
    for (const [i, c] of done.entries()) {
      messages.push({
        role: "tool",
        tool_call_id: String(c.id || `history_${i}`),
        content: String(c.result ?? "").slice(0, 20000) || (c.isError ? "error" : "ok"),
      });
    }
  }

  sse(res, "start", { model, tools: tools.map((t) => t.name), gateway: await resolveGateway().catch(() => gatewayURL()) });

  let usageTotal = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const payload = { model, messages, stream: true };
      if (effort) payload.reasoning_effort = effort;
      if (Number.isFinite(temperature)) payload.temperature = temperature;
      if (maxTokens > 0) payload.max_tokens = maxTokens;
      if (tools.length) {
        payload.tools = toFunctionTools(tools);
        payload.tool_choice = "auto";
      }

      const upstream = await chatCompletions(payload, { signal: abort.signal });
      if (!upstream.ok || !upstream.body) {
        const text = upstream.body ? (await upstream.text()).slice(0, 600) : "";
        sse(res, "error", { message: `magpie ${upstream.status}${text ? " · " + text : ""}` });
        res.end();
        return;
      }

      let content = "";
      let reasoning = "";
      const calls = new Map(); // index -> { id, name, args }
      let finish = "";

      for await (const chunk of sseChunks(upstream)) {
        const choice = chunk?.choices?.[0];
        if (chunk?.usage) {
          usageTotal = {
            prompt_tokens: usageTotal.prompt_tokens + (chunk.usage.prompt_tokens || 0),
            completion_tokens: usageTotal.completion_tokens + (chunk.usage.completion_tokens || 0),
            total_tokens: usageTotal.total_tokens + (chunk.usage.total_tokens || 0),
          };
        }
        if (!choice) continue;
        const d = choice.delta || {};
        if (d.reasoning_content) { reasoning += d.reasoning_content; sse(res, "reasoning", { text: d.reasoning_content }); }
        if (d.content) { content += d.content; sse(res, "delta", { text: d.content }); }
        for (const tc of d.tool_calls || []) {
          const i = tc.index ?? 0;
          const cur = calls.get(i) || { id: "", name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(i, cur);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }

      if (calls.size && (finish === "tool_calls" || finish === "stop")) {
        const made = [...calls.values()].filter((c) => c.name);
        if (!made.length) { sse(res, "done", { ms: Date.now() - started, usage: usageTotal }); res.end(); return; }

        messages.push({
          role: "assistant",
          content: content || "",
          tool_calls: made.map((c, i) => ({ id: c.id || `call_${round}_${i}`, type: "function", function: { name: c.name, arguments: c.args || "{}" } })),
        });
        if (content) sse(res, "delta", { text: "" });

        for (const c of made) {
          const id = c.id || `call_${round}`;
          let args = {};
          try { args = JSON.parse(c.args || "{}"); } catch { args = {}; }
          const tool = tools.find((t) => t.name === c.name) || tools.find((t) => t.rawName === c.name);
          sse(res, "tool", { phase: "call", id, name: c.name, args });
          let result = "", isError = false;
          if (!tool) {
            result = "没有这个工具：" + c.name; isError = true;
          } else {
            const server = (await readMcp()).find((s) => s.name === tool.server);
            try {
              const out = await callTool(server, tool.rawName, args);
              result = out.text; isError = Boolean(out.isError);
            } catch (err) {
              result = String(err?.message || err); isError = true;
            }
          }
          sse(res, "tool", { phase: "result", id, name: c.name, args, result: String(result).slice(0, 20000), isError });
          messages.push({ role: "tool", tool_call_id: id, content: String(result).slice(0, 60000) || (isError ? "error" : "ok") });
        }
        continue; // 让模型基于工具结果继续
      }

      sse(res, "usage", usageTotal);
      sse(res, "done", { ms: Date.now() - started });
      res.end();
      return;
    }
    sse(res, "error", { message: `工具调用超过 ${MAX_TOOL_ROUNDS} 轮，已停下` });
    res.end();
  } catch (err) {
    if (abort.signal.aborted) { sse(res, "done", { ms: Date.now() - started, stopped: true }); }
    else sse(res, "error", { message: String(err?.message || err) });
    res.end();
  } finally {
    if (clientId) controllers.delete(clientId);
  }
}

export async function startServer({ configDir: dirArg, options = {} } = {}) {
  // 这里必须把空值规范掉：调用方常传 configDir: ""，而 libraryView(dir = configDir())
  // 的默认值只在参数是 undefined 时生效。传空字符串会让 join("", "library") 变成
  // 相对路径 "library"，从进程当前目录找，结果指令 / 技能 / MCP 全是空的。
  const dir = dirArg || configDir();
  const store = createStore(dir);
  const controllers = new Map();
  const port = Number(options.port || process.env.MAGPIE_CHAT_PORT || 3477);
  OWN = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  // 模型列表缓存几十秒，够界面用，又不用每次开页都等网关
  let cache = { at: 0, models: [] };
  async function models(opts = {}) {
    if (Date.now() - cache.at < 30e3 && cache.models.length) return cache.models;
    const list = await listModels(opts);
    cache = { at: Date.now(), models: list };
    return list;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1:" + port);
    const path = url.pathname;
    if (!originAllowed(req)) return send(res, 403, { error: "只服务于 magpie 窗口里的对话页" });
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(req));
      return res.end();
    }

    try {
      if (path.startsWith("/api/")) {
        if (req.method === "GET" && path === "/api/bootstrap") {
          const settings = await store.settings();
          let list = [];
          let gatewayError = "";
          await resolveGateway(options).catch(() => "");
          try { list = await models(options); } catch (err) { gatewayError = String(err?.message || err); }
          // 模型图标：magpie 的 providers.json 里有各供应商的 logo，能对上就带上
          try {
            const icons = await providerIcons(dir);
            // group/<id> 这种路由组没有自己的图标，借组里第一个供应商的
            const groups = await groupIcons(dir).catch(() => new Map());
            list = list.map((m) => {
              // 路由组（group/*）的 provider 是 "group"，实际供应商在 owner 里
              const icon = icons.get(m.owner) || icons.get(m.provider)
                || (m.provider === "group" ? icons.get(groups.get(m.id.replace(/^group\//, "")) || "") : "");
              return { ...m, icon: icon || "" };
            });
          } catch { /* 没有图标就只显示名字 */ }
          if (!settings.model && list.length) settings.model = list[0].id;
          const effortOK = list.find((m) => m.id === settings.model)?.efforts?.includes(settings.effort);
          if (!effortOK) settings.effort = "";
          return send(res, 200, {
            port,
            version: "0.1.0",
            gateway: gatewayURL(options),
            settings,
            models: list,
            library: await libraryView(dir),
            error: gatewayError,
          });
        }
        // 供应商图标：模型名字前面那个小图标
        const iconHit = /^\/api\/icon\/([^/]+)$/.exec(path);
        if (iconHit && req.method === "GET") {
          const pid = decodeURIComponent(iconHit[1]);
          const icon = await readProviderIcon(pid, dir).catch(() => null);
          if (icon && icon.url) return send(res, 302, "", "text/plain");
          // 没有图片文件就画一个首字母徽章（magpie 的内置图标编在二进制里，取不到）
          const body = icon ? icon.data : letterIcon(pid);
          res.writeHead(200, {
            "content-type": icon ? icon.type || "application/octet-stream" : "image/svg+xml",
            "cache-control": "public, max-age=86400",
            "access-control-allow-origin": "*",
          });
          return res.end(body);
        }
        // 探活：带路页在跳转前先打这个，确认服务已经起来，
        // 免得页面直接撞上"127.0.0.1 拒绝连接"。
        if (path === "/api/ping" && req.method === "GET") {
          // 版本号从 package.json 读，别再写死（写死会跟实际版本对不上）
          // 报实际端口（可能不是 3477，被占时会退到 3478…）
          return send(res, 200, { ok: true, port: actualPort, version: VERSION });
        }

        // 字体：直接读 magpie 设置里的 uiFont / codeFont，生成一份 CSS 给页面用。
        //
        // 为什么从服务端读，而不是让带路页在 magpie 页面里读 CSS 变量：
        //   带路页能读，但读的时机靠不住 —— magpie 是在设置加载完之后才把
        //   --ui-font 写到 :root 上的，带路页 await 完 magpie.ready 立刻读，
        //   经常读到空值；页面 CSP 是 connect-src 'none'，读不到也没法重试。
        //   服务是普通 node 进程，直接读 settings.json，什么时候读都准。
        if (path === "/api/fonts.css" && req.method === "GET") {
          const css = await fontCss();
          res.writeHead(200, {
            "content-type": "text/css; charset=utf-8",
            "cache-control": "no-store",
            "access-control-allow-origin": "*",
          });
          return res.end(css);
        }

        if (path === "/api/upload" && req.method === "POST") {
          const body = await readBody(req);
          const name = String(body.name || "file").slice(0, 200);
          const type = String(body.type || "");
          const data = String(body.data || "");
          if (!data) return send(res, 400, { error: "没有内容" });
          // 图片保留 data URL 直接给模型；文本文件转成文本附件
          const isImage = /^image\//.test(type);
          if (isImage && data.length > 24 * 1024 * 1024) return send(res, 413, { error: "图片太大（上限约 24MB）" });
          if (!isImage && data.length > 8 * 1024 * 1024) return send(res, 413, { error: "文件太大（上限约 8MB）" });
          return send(res, 200, { name, type, kind: isImage ? "image" : "file", size: data.length, data });
        }
        if (path === "/api/settings" && req.method === "GET") return send(res, 200, await store.settings());
        if (path === "/api/settings" && req.method === "POST") {
          const patch = await readBody(req);
          return send(res, 200, await store.saveSettings(patch));
        }
        if (path === "/api/library" && req.method === "GET") return send(res, 200, await libraryView(dir));
        if (path === "/api/mcp/tools" && req.method === "GET") {
          const settings = await store.settings();
          const servers = (await readMcp(dir)).filter((s) => settings.mcp.includes(s.name));
          const out = [];
          for (const s of servers) {
            try {
              const tools = await listTools(s);
              out.push({ name: s.name, ok: true, tools: tools.map((t) => ({ name: t.name, description: t.description, server: s.name })) });
            } catch (err) {
              out.push({ name: s.name, ok: false, error: String(err?.message || err), tools: [] });
            }
          }
          return send(res, 200, { servers: out });
        }
        if (path === "/api/models" && req.method === "GET") {
          try { return send(res, 200, { models: await models(options) }); }
          catch (err) { return send(res, 502, { error: String(err?.message || err), models: [] }); }
        }
        if (path === "/api/conversations" && req.method === "GET") return send(res, 200, { items: await store.listConversations() });
        if (path === "/api/conversations" && req.method === "POST") {
          const body = await readBody(req);
          return send(res, 200, await store.saveConversation(body || {}));
        }
        const conv = /^\/api\/conversations\/([\w-]+)$/.exec(path);
        if (conv && req.method === "GET") {
          const c = await store.getConversation(conv[1]);
          return c ? send(res, 200, c) : send(res, 404, { error: "没有这个对话" });
        }
        if (conv && req.method === "DELETE") {
          await store.removeConversation(conv[1]);
          return send(res, 200, { ok: true });
        }
        // 只改标题：/api/conversations 的 POST 会整份覆盖（messages 也会被清空），
        // 所以重命名单独走 PATCH。
        if (conv && req.method === "PATCH") {
          const body = await readBody(req);
          const c = await store.getConversation(conv[1]);
          if (!c) return send(res, 404, { error: "没有这个对话" });
          const title = String(body.title || "").trim().replace(/\s+/g, " ").slice(0, 90);
          if (!title) return send(res, 400, { error: "标题不能为空" });
          c.title = title;
          c.updated = Date.now();
          await writeFile(store.convPath(conv[1]), JSON.stringify(c));
          return send(res, 200, { id: c.id, title: c.title, updated: c.updated });
        }
        if (path === "/api/chat" && req.method === "POST") {
          const body = await readBody(req);
          const settings = await store.settings();
          sseHead(res);
          await runChat({ res, body, settings, store }, controllers);
          return;
        }
        if (path === "/api/chat/stop" && req.method === "POST") {
          const body = await readBody(req).catch(() => ({}));
          const c = controllers.get(String(body.clientId || ""));
          if (c) c.abort();
          return send(res, 200, { ok: Boolean(c) });
        }
        return send(res, 404, { error: "没有这个接口：" + path });
      }

      // 静态：对话页自己的文件
      const rel = normalize(decodeURIComponent(path)).replace(/^([/\\.]+)/, "");
      const file = join(UI_ROOT, rel === "" ? "index.html" : rel);
      if (!file.startsWith(UI_ROOT)) return send(res, 403, { error: "forbidden" });
      const data = await readFile(file).catch(() => null);
      if (!data) return send(res, 404, "没有这个文件", "text/plain; charset=utf-8");
      return send(res, 200, data, MIME[extname(file).toLowerCase()] || "application/octet-stream");
    } catch (err) {
      if (res.headersSent) { try { res.end(); } catch { /* 已结束 */ } return; }
      return send(res, 500, { error: String(err?.message || err) });
    }
  });

  // 端口策略：先试指定的（默认 3477），被占就立刻换一个空闲端口 ——
  // 不再傻等 6 秒。窗口里常常同时有命令行 magpie 和桌面 magpie 两个宿主，
  // 抢同一个端口是常态；谁抢到谁服务，后来者换一个端口照样能用。
  const bindOn = (p) => new Promise((resolve, reject) => {
    const onError = (err) => { server.removeListener("listening", onListening); reject(err); };
    const onListening = () => { server.removeListener("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(p, "127.0.0.1");
  });

  // 从 0 让内核分配一个空闲端口，拿它的实际值
  const bindEphemeral = () => new Promise((resolve, reject) => {
    const onError = (err) => { server.removeListener("listening", onListening); reject(err); };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(server.address().port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

  const actualPort = port;

  // 端口固定用 3477 —— 带路页写死了跳这个端口（页面 CSP 是 connect-src 'none'，
  // 没法先探测再决定跳哪，只能盲跳）。所以这里也必须是 3477，换端口页面就连不上了。
  // 被上一次的宿主占着就等它松手，最多等 6 秒。
  let bound = false;
  for (let i = 0; i < 12 && !bound; i++) {
    try {
      await bindOn(port);
      bound = true;
    } catch (err) {
      if (err?.code !== "EADDRINUSE") throw err;
      if (i === 0) console.log(`[page-chat] ${port} 被上一次的宿主占着，等一下再绑`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!bound) throw new Error(`${port} 一直被占用，服务起不来`);

  // 把实际端口写到配置目录，带路页（page/boot.js）会来读 ——
  // 端口可能是换过的，页面不能假设永远是 3477。
  try {
    // dir 可能是空字符串（没传 configDir），交给 dataDir 落到默认配置目录
    const cfgRoot = dataDir(dir);
    writeFileSync(join(cfgRoot, "port.json"), JSON.stringify({ port: actualPort, at: Date.now() }));
  } catch (err) {
    console.warn("[page-chat] 端口文件写失败:", err?.message || err);
  }

  return { port: actualPort, server, store, close: async () => { await closeAll(); server.close(); } };
}
