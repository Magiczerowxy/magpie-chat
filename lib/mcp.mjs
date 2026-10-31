// magpie MCP 客户端：Streamable HTTP + stdio。只依赖 Node/Bun 内置模块与全局 fetch。
// 契约见 CONTRACT.md「lib/mcp.mjs 必需导出」。
import { mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

const PROTOCOL_VERSION = "2024-11-05";
const CLIENT_INFO = { name: "magpie", version: "0.1.0" };
const TIMEOUT_MS = 60_000;

const httpSessions = new Map(); // key -> { id, ready }
const stdioSessions = new Map(); // key -> { proc, buf, err, pending, seq, closed, ready }
let seq = 0;

/* ---------------- 配置 ---------------- */

// 与 lib/library.mjs 的 configDir 保持一致：支持 XDG_CONFIG_HOME 覆盖
function configDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? path.join(xdg, "magpie") : path.join(homedir(), ".config", "magpie");
}

// stdio MCP 服务器的工作目录。
//
// 以前 spawn 不传 cwd，服务器就继承 chat 服务的当前目录：
//   - 在 magpie 插件宿主里 = ~/.config/magpie（和 settings.json、providers.json 并排，
//     模型让工具存个 providers.json 就把 magpie 自己的配置覆盖了）；
//   - 手工 node serve.mjs = 插件安装目录（更新时会被替换），或执行命令时所在的目录（常常是 ~）。
// 用户也会在 home 里看到 page_xxx.html、magpie_readme.md 这种莫名其妙冒出来的文件。
// 现在统一给一个插件自己的工作区，并把 PWD 指过去，工具用相对路径写的东西都落在这里。
export function workspaceDir() {
  const dir = path.join(configDir(), "magpie-chat", "workspace");
  try { mkdirSync(dir, { recursive: true }); } catch { /* 建不了就让 spawn 自己报错 */ }
  return dir;
}

export function loadServers() {
  const file =
    process.env.MAGPIE_LIBRARY || path.join(configDir(), "library.json");
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return []; // 没装过 magpie 配置就当没有服务器
    throw new Error(`读取 magpie 配置失败：${file}（${e.message}）`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`magpie 配置不是合法 JSON：${file}（${e.message}）`);
  }
  const list = Array.isArray(data?.mcp) ? data.mcp : [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || !item.name) continue;
    const transport =
      item.transport === "stdio" || item.transport === "http"
        ? item.transport
        : item.command
          ? "stdio"
          : "http";
    const server = { name: String(item.name), transport };
    // library.mjs 会带 detail 字段，这里也保留，方便前端展示
    if (typeof item.detail === "string") server.detail = item.detail;
    if (item.env && typeof item.env === "object") server.env = { ...item.env };
    if (transport === "http") {
      server.url = typeof item.url === "string" ? item.url : "";
      if (item.headers && typeof item.headers === "object") server.headers = { ...item.headers };
    } else {
      server.command = typeof item.command === "string" ? item.command : "";
      server.args = Array.isArray(item.args) ? item.args.map(String) : [];
    }
    out.push(server);
  }
  return out;
}

/* ---------------- 对外 API ---------------- */

export async function listTools(server) {
  const target = targetOf(server);
  const result = await rpc(target, "tools/list", {});
  const tools = Array.isArray(result?.tools) ? result.tools : [];
  return tools.map((t) => ({
    name: String(t?.name ?? ""),
    description: typeof t?.description === "string" ? t.description : "",
    inputSchema: t?.inputSchema ?? { type: "object", properties: {} },
    server: target.name,
  }));
}

export async function callTool(server, name, args) {
  if (!name) throw new Error("调用 MCP 工具时缺少工具名");
  const target = targetOf(server);
  const result = await rpc(target, "tools/call", {
    name: String(name),
    arguments: args && typeof args === "object" ? args : {},
  });
  const parts = [];
  for (const c of Array.isArray(result?.content) ? result.content : []) {
    if (c?.type === "text") parts.push(String(c.text ?? ""));
    else if (c?.type === "image") parts.push(`[图片 ${c.mimeType ?? "unknown"}，已省略]`);
    else if (c?.type === "resource") parts.push(String(c.resource?.text ?? `[资源 ${c.resource?.uri ?? ""}]`));
    else if (c?.type === "audio") parts.push(`[音频 ${c.mimeType ?? "unknown"}，已省略]`);
    else parts.push(JSON.stringify(c));
  }
  let text = parts.join("\n").trim();
  if (!text && result?.structuredContent) text = JSON.stringify(result.structuredContent, null, 2);
  if (!text && result != null) text = JSON.stringify(result);
  return { text, isError: Boolean(result?.isError) };
}

export async function closeAll() {
  for (const session of stdioSessions.values()) killStdio(session);
  stdioSessions.clear();
  httpSessions.clear();
}

/* ---------------- 公共 ---------------- */

function targetOf(server) {
  if (typeof server === "string") {
    const found = loadServers().find((s) => s.name === server);
    if (!found) throw new Error(`未在 magpie 配置里找到 MCP 服务器「${server}」`);
    server = found;
  }
  if (!server || typeof server !== "object" || !server.name) {
    throw new Error("MCP 服务器配置无效：缺少 name");
  }
  const transport = server.transport === "stdio" ? "stdio" : "http";
  const target = { name: String(server.name), transport };
  if (transport === "http") {
    if (!server.url) throw new Error(`MCP 服务器「${target.name}」缺少 url，无法连接`);
    target.url = server.url;
    target.headers =
      server.headers && typeof server.headers === "object" ? { ...server.headers } : {};
  } else {
    if (!server.command) throw new Error(`MCP 服务器「${target.name}」缺少 command，无法启动`);
    target.command = server.command;
    target.args = Array.isArray(server.args) ? server.args.map(String) : [];
    target.env = server.env && typeof server.env === "object" ? { ...server.env } : null;
  }
  target.key = `${target.name}\u0000${transport === "http" ? target.url : target.command}`;
  return target;
}

function rpc(target, method, params) {
  return target.transport === "http"
    ? httpRpc(target, method, params)
    : stdioRpc(target, method, params);
}

/* ---------------- HTTP (Streamable MCP) ---------------- */

async function ensureHttp(target) {
  let session = httpSessions.get(target.key);
  if (session) {
    await session.ready;
    return session;
  }
  session = { id: null, ready: null };
  session.ready = (async () => {
    const id = ++seq;
    const res = await httpPost(
      target,
      {
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
      },
      session,
    );
    session.id = res.headers.get("mcp-session-id") || null;
    const msg = await readRpc(target, res, id);
    if (!msg) throw new Error(`MCP 服务器「${target.name}」的 initialize 没有返回结果`);
    if (msg.error) {
      throw new Error(
        `MCP 服务器「${target.name}」拒绝初始化：${msg.error.message || JSON.stringify(msg.error)}`,
      );
    }
    // initialized 通知：部分实现不回 202，出错也不阻断后续调用
    try {
      const note = await httpPost(target, { jsonrpc: "2.0", method: "notifications/initialized" }, session);
      const sid = note.headers.get("mcp-session-id");
      if (sid) session.id = sid;
      await note.text().catch(() => "");
    } catch {
      /* ignore */
    }
  })().catch((e) => {
    httpSessions.delete(target.key);
    throw e;
  });
  session.ready.catch(() => {});
  httpSessions.set(target.key, session);
  await session.ready;
  return session;
}

async function httpRpc(target, method, params) {
  let session = await ensureHttp(target);
  const attempt = async () => {
    const id = ++seq;
    const res = await httpPost(target, { jsonrpc: "2.0", id, method, params }, session);
    const sid = res.headers.get("mcp-session-id");
    if (sid) session.id = sid;
    if (res.status === 404 && session.id) {
      await res.text().catch(() => "");
      const err = new Error("MCP 会话已过期");
      err.expired = true;
      throw err;
    }
    const msg = await readRpc(target, res, id);
    if (!msg) throw new Error(`MCP 服务器「${target.name}」没有返回 ${method} 的结果`);
    if (msg.error) {
      throw new Error(
        `MCP 服务器「${target.name}」执行 ${method} 出错：${msg.error.message || JSON.stringify(msg.error)}`,
      );
    }
    return msg.result;
  };
  try {
    return await attempt();
  } catch (e) {
    if (!e.expired) throw e;
    httpSessions.delete(target.key);
    session = await ensureHttp(target);
    return await attempt();
  }
}

async function httpPost(target, body, session) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...target.headers,
  };
  if (session?.id) headers["mcp-session-id"] = session.id;
  try {
    return await fetch(target.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const reason =
      e?.name === "TimeoutError"
        ? `超过 ${TIMEOUT_MS / 1000}s 未响应`
        : e?.cause?.message || e?.message || String(e);
    throw new Error(`连接 MCP 服务器「${target.name}」失败（${target.url}）：${reason}`);
  }
}

async function readRpc(target, res, id) {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const hint =
      res.status === 401 || res.status === 403
        ? "，请检查 headers 里的 Authorization"
        : res.status === 404
          ? "，地址或会话不存在"
          : "";
    throw new Error(
      `MCP 服务器「${target.name}」返回 HTTP ${res.status}${hint}${body ? `：${body.slice(0, 300)}` : ""}`,
    );
  }
  if (res.status === 202 || res.status === 204) return null;
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const text = await res.text();
  if (!text.trim()) return null;
  const messages = ct.includes("text/event-stream") || text.startsWith("data:")
    ? parseSse(text)
    : parseJson(text);
  return pick(messages, id);
}

function parseJson(text) {
  try {
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [data];
  } catch {
    throw new Error(`MCP 服务器返回了无法解析的响应：${text.slice(0, 200)}`);
  }
}

function parseSse(text) {
  const out = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n")
      .trim();
    if (!data) continue;
    try {
      const msg = JSON.parse(data);
      if (Array.isArray(msg)) out.push(...msg);
      else out.push(msg);
    } catch {
      /* 心跳或非 JSON 事件，忽略 */
    }
  }
  return out;
}

function pick(messages, id) {
  if (!messages.length) return null;
  const same = (m) => m && String(m.id) === String(id);
  return messages.find(same) || messages.find((m) => m && m.id !== undefined && m.id !== null) || null;
}

/* ---------------- stdio ---------------- */

function ensureStdio(target) {
  const existing = stdioSessions.get(target.key);
  if (existing) return existing;
  const session = { proc: null, buf: "", err: "", pending: new Map(), seq: 0, closed: false };
  session.ready = (async () => {
    // 固定一个工作区：工具用相对路径写的文件不会落到 magpie 配置目录或 home 里
    const cwd = workspaceDir();
    const proc = spawn(target.command, target.args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...(target.env ? { ...process.env, ...target.env } : process.env), PWD: cwd },
    });
    session.proc = proc;
    proc.stdin.on("error", () => {});
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => onStdout(session, target, chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => {
      session.err = (session.err + chunk).slice(-4000);
    });
    proc.on("error", (e) => {
      const hint = e?.code === "ENOENT" ? "（命令不存在，检查是否已安装或不在 PATH）" : "";
      fail(session, `无法启动 MCP 服务器「${target.name}」：${target.command}${hint}（${e.message}）`);
    });
    proc.on("exit", (code, signal) => {
      if (session.closed) return;
      const tail = session.err.trim().slice(-600);
      fail(
        session,
        `MCP 服务器「${target.name}」（${target.command}）已退出（code=${code}${signal ? `, signal=${signal}` : ""}）${tail ? `：${tail}` : ""}`,
      );
      stdioSessions.delete(target.key);
    });
    await stdioCall(session, target, "initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    send(session, { jsonrpc: "2.0", method: "notifications/initialized" });
  })().catch((e) => {
    killStdio(session);
    stdioSessions.delete(target.key);
    throw e;
  });
  session.ready.catch(() => {});
  stdioSessions.set(target.key, session);
  return session;
}

async function stdioRpc(target, method, params) {
  const session = ensureStdio(target);
  await session.ready;
  return stdioCall(session, target, method, params);
}

function stdioCall(session, target, method, params) {
  if (session.closed) return Promise.reject(new Error(`MCP 服务器「${target.name}」已停止`));
  const id = ++session.seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pending.delete(id);
      const tail = session.err.trim().slice(-400);
      reject(
        new Error(
          `MCP 服务器「${target.name}」在 ${TIMEOUT_MS / 1000}s 内没有响应 ${method}${tail ? `：${tail}` : ""}`,
        ),
      );
    }, TIMEOUT_MS);
    timer.unref?.();
    session.pending.set(id, { resolve, reject, timer, method });
    if (!send(session, { jsonrpc: "2.0", id, method, params })) {
      session.pending.delete(id);
      clearTimeout(timer);
      const tail = session.err.trim().slice(-400);
      reject(
        new Error(
          `无法向 MCP 服务器「${target.name}」写入请求，进程可能已退出${tail ? `：${tail}` : ""}`,
        ),
      );
    }
  });
}

function send(session, msg) {
  const proc = session.proc;
  if (!proc || proc.exitCode !== null || !proc.stdin.writable) return false;
  try {
    proc.stdin.write(JSON.stringify(msg) + "\n");
    return true;
  } catch {
    return false;
  }
}

function onStdout(session, target, chunk) {
  session.buf += chunk;
  let idx;
  while ((idx = session.buf.indexOf("\n")) >= 0) {
    const line = session.buf.slice(0, idx).trim();
    session.buf = session.buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // 非 JSON 行（启动日志等）直接跳过
    }
    for (const m of Array.isArray(msg) ? msg : [msg]) handleStdioMessage(session, target, m);
  }
}

function handleStdioMessage(session, target, msg) {
  if (!msg || typeof msg !== "object") return;
  const pending = msg.id !== undefined && msg.id !== null ? session.pending.get(msg.id) : undefined;
  if (pending) {
    session.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) {
      pending.reject(
        new Error(
          `MCP 服务器「${target.name}」执行 ${pending.method} 出错：${msg.error.message || JSON.stringify(msg.error)}`,
        ),
      );
    } else {
      pending.resolve(msg.result);
    }
    return;
  }
  // 服务器反向请求（ping / roots 等）：回空结果，避免对方等待
  if (msg.id !== undefined && msg.id !== null && msg.method) {
    send(
      session,
      msg.method === "ping"
        ? { jsonrpc: "2.0", id: msg.id, result: {} }
        : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not supported" } },
    );
  }
}

function fail(session, message) {
  session.closed = true;
  for (const p of session.pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error(message));
  }
  session.pending.clear();
}

function killStdio(session) {
  session.closed = true;
  fail(session, "MCP 客户端已关闭");
  const proc = session.proc;
  if (!proc || proc.exitCode !== null) return;
  try {
    proc.kill();
  } catch {
    /* ignore */
  }
  const timer = setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }, 2000);
  timer.unref?.();
}
