// 读 magpie 自己的资源库：指令、技能、MCP 服务器。
// 这些是用户在 magpie 里配好的东西，插件只是照着用，不改它们。

import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function configDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "magpie");
  return join(homedir(), ".config", "magpie");
}

export function libraryDir(dir = configDir()) {
  return join(dir, "library");
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

// SKILL.md 的 frontmatter：name 与 description，够用即可
function frontmatter(text) {
  const out = { name: "", description: "" };
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (k === "name") out.name = v;
    else if (k === "description") out.description = v;
  }
  return out;
}

export async function readInstructions(dir = configDir()) {
  const root = join(libraryDir(dir), "instructions");
  if (!existsSync(root)) return [];
  const names = await readdir(root).catch(() => []);
  const out = [];
  for (const file of names) {
    if (!/\.(md|markdown|txt)$/i.test(file)) continue;
    const path = join(root, file);
    const st = await stat(path).catch(() => null);
    if (!st?.isFile()) continue;
    out.push({ id: file.replace(/\.(md|markdown|txt)$/i, ""), name: file, size: st.size, path });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readSkills(dir = configDir()) {
  const root = join(libraryDir(dir), "skills");
  if (!existsSync(root)) return [];
  const names = await readdir(root).catch(() => []);
  const out = [];
  for (const name of names) {
    const path = join(root, name, "SKILL.md");
    if (!existsSync(path)) continue;
    const text = await readFile(path, "utf8").catch(() => "");
    const fm = frontmatter(text);
    out.push({
      name: fm.name || name,
      description: fm.description,
      path,
      body: text.replace(/^---[\s\S]*?---\r?\n/, "").trim(),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readMcp(dir = configDir()) {
  // magpie 的 MCP 列表在配置目录的 library.json（library/ 里放的是指令和技能的正文）
  const lib = await readJson(join(dir, "library.json"), {});
  const list = Array.isArray(lib.mcp) ? lib.mcp : [];
  return list.map((m) => ({
    name: m.name || m.url || m.command || "mcp",
    transport: m.transport === "stdio" ? "stdio" : "http",
    url: m.url,
    headers: m.headers && typeof m.headers === "object" ? m.headers : undefined,
    command: m.command,
    args: Array.isArray(m.args) ? m.args : undefined,
    env: m.env && typeof m.env === "object" ? m.env : undefined,
    detail: m.url || [m.command, ...(m.args || [])].join(" "),
  }));
}

// 给前端的精简视图（不带正文，免得 bootstrap 太重）
export async function libraryView(dir = configDir()) {
  const [instructions, skills, mcp] = await Promise.all([readInstructions(dir), readSkills(dir), readMcp(dir)]);
  return {
    instructions: instructions.map(({ id, name, size }) => ({ id, name, size })),
    skills: skills.map(({ name, description }) => ({ name, description })),
    mcp: mcp.map(({ name, transport, detail }) => ({ name, transport, detail })),
  };
}

// 组装 system prompt：用户自己写的 + 勾选的指令 + 勾选的技能
export async function composeSystem(settings, dir = configDir()) {
  const parts = [];
  // 开关关掉时，用户手写的那段不进去（勾选的指令和技能照旧生效）
  const mine = settings.systemEnabled === false ? "" : String(settings.system || "").trim();
  if (mine) parts.push(mine);
  const [instructions, skills] = await Promise.all([readInstructions(dir), readSkills(dir)]);
  for (const id of settings.instructions || []) {
    const hit = instructions.find((x) => x.id === id || x.name === id);
    if (!hit) continue;
    const text = await readFile(hit.path, "utf8").catch(() => "");
    if (text.trim()) parts.push(`# ${hit.id}\n\n${text.trim()}`);
  }
  for (const name of settings.skills || []) {
    const hit = skills.find((x) => x.name === name);
    if (!hit) continue;
    parts.push(`# Skill: ${hit.name}\n\n${hit.description ? hit.description + "\n\n" : ""}${hit.body}`);
  }
  return parts.join("\n\n---\n\n");
}

// 供应商图标：magpie 的 providers.json 里每个供应商有 icon，
// 可能是内置图标名（deepseek-color）、file: 本地文件，或 http 地址。
// 这里统一变成服务端能直接给的 URL（api/icon/<provider>，相对对话页，经 magpie web 转发时也对），取不到就不给。
export async function providerIcons(dir = configDir()) {
  const out = new Map();
  const providers = await readJson(join(dir, "providers.json"), null);
  const list = Array.isArray(providers) ? providers : Array.isArray(providers?.providers) ? providers.providers : [];
  for (const p of list) {
    if (!p || typeof p !== "object") continue;
    const id = p.id || p.name;
    const icon = p.icon || p.logo || "";
    if (!id || typeof icon !== "string" || !icon) continue;
    out.set(String(id), "api/icon/" + encodeURIComponent(String(id)));
  }
  return out;
}

// 路由组（group/<id>）本身没有图标：用组里第一个成员模型的供应商图标顶上。
export async function groupIcons(dir = configDir()) {
  const out = new Map();
  const groups = await readJson(join(dir, "providers.json"), null).catch(() => null);
  const routing = await readJson(join(dir, "routing.json"), null).catch(() => null);
  const list = Array.isArray(routing) ? routing : Array.isArray(routing?.groups) ? routing.groups : [];
  for (const g of list) {
    if (!g || typeof g !== "object") continue;
    const id = g.id || g.name;
    const members = Array.isArray(g.models) ? g.models : Array.isArray(g.members) ? g.members : [];
    const first = members.find((m) => typeof m === "string" && m.includes("/"));
    if (id && first) out.set(String(id), first.slice(0, first.indexOf("/")));
  }
  void groups;
  return out;
}

// 真去磁盘/网络拿那个图标，回给页面
export async function readProviderIcon(providerId, dir = configDir()) {
  const providers = await readJson(join(dir, "providers.json"), null);
  const list = Array.isArray(providers) ? providers : Array.isArray(providers?.providers) ? providers.providers : [];
  const p = list.find((x) => x && String(x.id || x.name) === String(providerId));
  const icon = p && (p.icon || p.logo);
  if (!icon || typeof icon !== "string") return null;

  // 1) file:xxx → 配置目录 icons/ 下的文件
  if (icon.startsWith("file:")) {
    const name = icon.slice(5).replace(/[^\w.-]/g, "");
    if (!name) return null;
    for (const base of [join(dir, "icons"), dir]) {
      const data = await readFile(join(base, name)).catch(() => null);
      if (data) return { data, type: mimeOf(name) };
    }
    return null;
  }

  // 2) 内置图标名（deepseek-color 之类）：magpie 把它们编在自己身上，
  //    只在可执行文件旁边有解包目录时才找得到；找不到就当没有图标。
  if (!/^(https?:|data:)/.test(icon)) {
    const name = icon.replace(/[^\w.-]/g, "");
    const roots = [
      join(dir, "icons"),
      join(dir, "..", "assets", "icons"),
      join(dir, "..", "..", "assets", "icons"),
    ];
    for (const root of roots) {
      for (const ext of [".svg", ".png", ".webp", ".ico"]) {
        const data = await readFile(join(root, name + ext)).catch(() => null);
        if (data) return { data, type: mimeOf(name + ext) };
      }
    }
    return null;
  }

  // 3) http(s) 图标：不代拉（页面本身没有网络），直接用远程地址
  return { url: icon };
}

function mimeOf(name) {
  const ext = String(name).toLowerCase().split(".").pop();
  return { svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", ico: "image/x-icon" }[ext] || "application/octet-stream";
}

export { readJson };
