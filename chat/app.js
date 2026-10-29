"use strict";

/* magpie chat —— 原生 JS，无构建、无外部依赖、无本地存储（opaque origin）。 */

/* 窗口外观：magpie 桥接层用 URL 把窗口的真实主题和设计令牌传进来。
   - ?theme=dark|light         → 覆盖 prefers-color-scheme 的兜底配色
   - ?tokens=<base64 JSON>     → 直接把窗口的 --bg/--card/--fg-2/--accent… 挂到 :root 上
   脚本是 defer 的，这里同步执行，赶在首帧之前定好变量，不会先闪一下兜底色。 */
(function applyWindowLook() {
  var root = document.documentElement;
  var params = null;
  try { params = new URLSearchParams(location.search); } catch (err) { params = null; }

  var theme = "";
  try { theme = String((params && params.get("theme")) || "").trim().toLowerCase(); } catch (err) { theme = ""; }
  if (theme === "dark" || theme === "light") root.dataset.theme = theme;

  var raw = "";
  try { raw = String((params && params.get("tokens")) || ""); } catch (err) { raw = ""; }
  if (!raw) return;

  var tokens = null;
  try {
    tokens = JSON.parse(decodeURIComponent(escape(atob(raw))));
  } catch (err) {
    return; /* 令牌坏了就当没有，落回兜底配色 */
  }
  if (!tokens || typeof tokens !== "object") return;

  var seen = Object.create(null);
  Object.keys(tokens).forEach(function (key) {
    var value = tokens[key];
    if (typeof value !== "string") return;
    var name = String(key).replace(/^--/, "").trim();
    if (!/^[A-Za-z0-9-]+$/.test(name) || !value.trim()) return;
    seen[name] = true;
    try { root.style.setProperty("--" + name, value.trim()); } catch (err) { /* 单个值坏了不影响其它 */ }
  });

  // 窗口令牌里没有派生色：popover 底色与选中态按已有令牌推，避免深浅主题下错位
  try {
    if (!seen["pop-bg"]) root.style.setProperty("--pop-bg", "color-mix(in srgb, var(--card) 94%, transparent)");
    if (!seen["sel"] && seen["accent-soft"]) root.style.setProperty("--sel", "var(--accent-soft)");
    if (!seen["card-2"]) root.style.setProperty("--card-2", "color-mix(in srgb, var(--card) 92%, var(--bg))");
    if (!seen["pill"]) root.style.setProperty("--pill", "color-mix(in srgb, var(--fg) 6%, var(--bg))");
    if (!seen["pill-hover"]) root.style.setProperty("--pill-hover", "color-mix(in srgb, var(--fg) 10%, var(--bg))");
    if (!seen["line-2"]) root.style.setProperty("--line-2", "color-mix(in srgb, var(--line) 60%, var(--bg))");
    if (!seen["ctl-fg"]) root.style.setProperty("--ctl-fg", "var(--fg-2)");
    if (!seen["green-soft"]) root.style.setProperty("--green-soft", "color-mix(in srgb, var(--green) 14%, var(--bg))");
    if (!seen["red-soft"]) root.style.setProperty("--red-soft", "color-mix(in srgb, var(--red) 14%, var(--bg))");
    if (!seen["amber-soft"]) root.style.setProperty("--amber-soft", "color-mix(in srgb, var(--amber) 14%, var(--bg))");
  } catch (err) { /* color-mix 不支持时保留兜底变量 */ }
})();

/* 窗口在页面导航走之后仍然给这个框架推主题事件（postMessage 跨源可用），
   所以 magpie 里切换深浅色 / 换主题时，对话页跟着换，而不是停在下车时那一刻。 */
(function followWindowTheme() {
  function apply(data) {
    if (!data || typeof data !== "object") return;
    var root = document.documentElement;
    if (typeof data.dark === "boolean") root.dataset.theme = data.dark ? "dark" : "light";
    var tokens = data.tokens;
    if (tokens && typeof tokens === "object") {
      Object.keys(tokens).forEach(function (key) {
        var value = tokens[key];
        if (typeof value !== "string" || !value.trim()) return;
        var name = String(key).replace(/^--/, "").trim();
        if (!/^[A-Za-z0-9-]+$/.test(name)) return;
        try { root.style.setProperty("--" + name, value.trim()); } catch (err) { /* 忽略坏值 */ }
      });
    }
    if (typeof data.lang === "string" && data.lang) root.lang = data.lang;
  }
  window.addEventListener("message", function (ev) {
    // 只认父窗口：别的框架或页面推什么都不算
    if (ev.source !== window.parent) return;
    var m = ev.data;
    if (!m || m.magpie !== 1) return;
    if (m.event === "theme") apply(m.data);
    else if (m.method === "theme" && m.result) apply(m.result);
  });
  // 有的窗口只把主题放在 ready 的应答里，再问一次当前值
  try { window.parent.postMessage({ magpie: 1, id: 0, method: "theme" }, "*"); } catch (err) { /* 不在框架里 */ }
})();

/* ================= 基础工具 ================= */

var $ = function (sel, root) { return (root || document).querySelector(sel); };
var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

function el(tag, props) {
  var node = document.createElement(tag);
  if (props) {
    Object.keys(props).forEach(function (key) {
      var value = props[key];
      if (value === null || value === undefined || value === false) return;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = String(value);
      else if (key === "dataset") Object.assign(node.dataset, value);
      else if (key.indexOf("on") === 0 && typeof value === "function") node.addEventListener(key.slice(2), value);
      else if (value === true) node.setAttribute(key, "");
      else node.setAttribute(key, String(value));
    });
  }
  for (var i = 2; i < arguments.length; i++) addKid(node, arguments[i]);
  return node;
}

function addKid(node, kid) {
  if (kid === null || kid === undefined || kid === false) return;
  if (Array.isArray(kid)) { kid.forEach(function (k) { addKid(node, k); }); return; }
  node.appendChild(typeof kid === "object" && kid.nodeType ? kid : document.createTextNode(String(kid)));
}

var CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
function cleanText(value) {
  return String(value === null || value === undefined ? "" : value).replace(CONTROL_RE, "");
}

function uid(prefix) {
  return (prefix || "id") + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function fmtTime(ms) {
  if (!ms || ms < 0) return "";
  if (ms < 1000) return ms + " ms";
  var s = ms / 1000;
  return (s >= 10 ? Math.round(s) : Math.round(s * 10) / 10) + " s";
}

function fmtNum(n) {
  n = Number(n);
  if (!isFinite(n)) return "0";
  return n >= 10000 ? Math.round(n / 100) / 10 + "k" : String(Math.round(n));
}

function relTime(ts) {
  if (!ts) return "";
  var diff = Date.now() - ts;
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
  if (diff < 86400000) return Math.floor(diff / 3600000) + " 小时前";
  var d = new Date(ts);
  return String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

/* ================= Markdown（最小子集，DOM 构建，永不插入未转义 HTML） ================= */

var INLINE_SRC = [
  "(\x60+)([\\s\\S]*?)\\1",
  "\\*\\*([\\s\\S]+?)\\*\\*",
  "(?<![\\w])__([\\s\\S]+?)__(?![\\w])",
  "~~([\\s\\S]+?)~~",
  "(?<![\\w*])\\*([^*\\n]+)\\*(?![\\w*])",
  "(?<![\\w])_([^_\\n]+)_(?![\\w])",
  "\\[([^\\]\\n]+)\\]\\(([^()\\s]+)\\)"
].join("|");

function safeHref(raw) {
  var url = String(raw || "").trim();
  if (!url) return "";
  if (/^(https?:\/\/|mailto:)/i.test(url)) return url;
  return "";
}

function appendText(parent, text) {
  var parts = String(text).split("\n");
  for (var i = 0; i < parts.length; i++) {
    if (i) parent.appendChild(document.createElement("br"));
    if (parts[i]) parent.appendChild(document.createTextNode(parts[i]));
  }
}

function inlineInto(parent, text) {
  var src = cleanText(text);
  var re = new RegExp(INLINE_SRC, "g");
  var last = 0;
  var m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) appendText(parent, src.slice(last, m.index));
    if (m[2] !== undefined) {
      parent.appendChild(el("code", { text: m[2] }));
    } else if (m[3] !== undefined || m[4] !== undefined) {
      var strong = el("strong");
      inlineInto(strong, m[3] !== undefined ? m[3] : m[4]);
      parent.appendChild(strong);
    } else if (m[5] !== undefined) {
      var del = el("del");
      inlineInto(del, m[5]);
      parent.appendChild(del);
    } else if (m[6] !== undefined || m[7] !== undefined) {
      var em = el("em");
      inlineInto(em, m[6] !== undefined ? m[6] : m[7]);
      parent.appendChild(em);
    } else if (m[9] !== undefined) {
      var href = safeHref(m[9]);
      if (href) {
        var a = el("a", { href: href, target: "_blank", rel: "noreferrer noopener" });
        inlineInto(a, m[8]);
        parent.appendChild(a);
      } else {
        appendText(parent, m[0]);
      }
    } else {
      appendText(parent, m[0]);
    }
    last = re.lastIndex;
  }
  if (last < src.length) appendText(parent, src.slice(last));
}

var LIST_RE = /^(\s{0,6})([-*+]|\d{1,3}[.)])\s+(.*)$/;
var FENCE_RE = /^\s*(\x60{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
var HEADING_RE = /^(#{1,6})\s+(.*)$/;
var HR_RE = /^\s*([-*_]\s*){3,}$/;
var QUOTE_RE = /^\s*>\s?/;
var TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function tableCells(line) {
  var s = line.trim();
  if (s.charAt(0) === "|") s = s.slice(1);
  if (s.charAt(s.length - 1) === "|") s = s.slice(0, -1);
  return s.split("|").map(function (c) { return c.trim(); });
}

function isTableStart(lines, i) {
  if (i + 1 >= lines.length) return false;
  if (lines[i].indexOf("|") < 0) return false;
  return TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].indexOf("-") >= 0;
}

function parseListBlock(lines, start) {
  var first = LIST_RE.exec(lines[start]);
  var root = el(/^\d/.test(first[2]) ? "ol" : "ul");
  var stack = [{ indent: first[1].length, list: root }];
  var lastLi = null;
  var i = start;
  while (i < lines.length) {
    var lm = LIST_RE.exec(lines[i]);
    if (!lm) {
      if (lines[i].trim() === "" && i + 1 < lines.length && LIST_RE.test(lines[i + 1])) { i++; continue; }
      break;
    }
    var indent = lm[1].length;
    var ordered = /^\d/.test(lm[2]);
    var top = stack[stack.length - 1];
    if (indent > top.indent && lastLi) {
      var nested = el(ordered ? "ol" : "ul");
      lastLi.appendChild(nested);
      stack.push({ indent: indent, list: nested });
    } else {
      while (stack.length > 1 && indent < stack[stack.length - 1].indent) stack.pop();
      var cur = stack[stack.length - 1];
      if (indent === cur.indent && (cur.list.tagName === "OL") !== ordered) {
        var nextList = el(ordered ? "ol" : "ul");
        if (cur.list.parentNode) cur.list.parentNode.insertBefore(nextList, cur.list.nextSibling);
        else root.appendChild(nextList);
        stack[stack.length - 1] = { indent: indent, list: nextList };
        lastLi = null;
      }
    }
    var target = stack[stack.length - 1].list;
    var li = el("li");
    inlineInto(li, lm[3]);
    target.appendChild(li);
    lastLi = li;
    i++;
  }
  return { node: root, next: i };
}

/* 流式专用渲染：把正文切成"已经写完的块"和"正在写的尾巴"
     - 稳定块（最后一个空行之前）只在跨过块边界时重渲染一次，之后整块缓存不再动
     - 尾巴是纯文本，每帧只改 textContent —— 不再每帧清空重建整个 DOM
   以前的写法每帧 renderMarkdown 全量重建，文字节点被反复替换、排版反复重算，
   看上去就是一直抽搐。 */
function renderStreaming(container, source) {
  var text = cleanText(source || "");
  var cut = text.lastIndexOf("\n\n");
  var stable = cut >= 0 ? text.slice(0, cut + 2) : "";
  var tail = cut >= 0 ? text.slice(cut + 2) : text;

  var stableEl = container.firstChild && container.firstChild.classList && container.firstChild.classList.contains("md-stable")
    ? container.firstChild : null;
  if (!stableEl) {
    while (container.firstChild) container.removeChild(container.firstChild);
    stableEl = el("div", { class: "md-stable" });
    container.appendChild(stableEl);
    container.appendChild(el("div", { class: "md-tail" }));
    container.dataset.stableLen = "-1";
  }
  var tailEl = container.lastChild;

  if (container.dataset.stableLen !== String(stable.length)) {
    renderMarkdown(stableEl, stable);
    container.dataset.stableLen = String(stable.length);
  }
  // 只改尾巴里那个文本节点的值：不重建节点，光标（tail 里的 span）也就不会被删掉重建
  var tnode = tailEl.firstChild;
  if (!tnode || tnode.nodeType !== 3) {
    tnode = document.createTextNode("");
    tailEl.insertBefore(tnode, tailEl.firstChild);
  }
  if (tnode.nodeValue !== tail) tnode.nodeValue = tail;
}

function renderMarkdown(container, source) {
  while (container.firstChild) container.removeChild(container.firstChild);
  var lines = cleanText(source).replace(/\r\n?/g, "\n").split("\n");
  var para = [];
  function flushPara() {
    if (!para.length) return;
    var p = el("p");
    inlineInto(p, para.join("\n"));
    container.appendChild(p);
    para = [];
  }
  var i = 0;
  while (i < lines.length) {
    var line = lines[i];

    var fence = FENCE_RE.exec(line);
    if (fence) {
      flushPara();
      var marker = fence[1].charAt(0);
      var closeRe = new RegExp("^\\s*" + (marker === "\x60" ? "\x60{3,}" : "~{3,}") + "\\s*$");
      var buf = [];
      i++;
      while (i < lines.length) {
        if (closeRe.test(lines[i])) { i++; break; }
        buf.push(lines[i]);
        i++;
      }
      var pre = el("pre", { class: "collapsible" });
      var lang = (fence[2] || "").trim() || "代码";
      var head = el("div", { class: "code-head" },
        el("span", { class: "caret", text: "\u25BE" }),
        el("span", { text: lang }),
        el("span", { class: "grow" }),
        el("span", { text: buf.length + " 行" })
      );
      pre.appendChild(head);
      pre.appendChild(el("code", { text: buf.join("\n") }));
      (function (node) {
        node.querySelector(".code-head").addEventListener("click", function () {
          node.classList.toggle("collapsed");
        });
      })(pre);
      container.appendChild(pre);
      continue;
    }

    if (!line.trim()) { flushPara(); i++; continue; }

    if (isTableStart(lines, i)) {
      flushPara();
      var head = tableCells(lines[i]);
      i += 2;
      var table = el("table");
      var thead = el("thead");
      var htr = el("tr");
      head.forEach(function (c) { var th = el("th"); inlineInto(th, c); htr.appendChild(th); });
      thead.appendChild(htr);
      table.appendChild(thead);
      var tbody = el("tbody");
      while (i < lines.length && lines[i].indexOf("|") >= 0 && lines[i].trim() !== "") {
        var row = el("tr");
        tableCells(lines[i]).forEach(function (c) { var td = el("td"); inlineInto(td, c); row.appendChild(td); });
        tbody.appendChild(row);
        i++;
      }
      table.appendChild(tbody);
      container.appendChild(table);
      continue;
    }

    var head2 = HEADING_RE.exec(line);
    if (head2) {
      flushPara();
      var h = el("h" + Math.min(head2[1].length + 1, 4));
      inlineInto(h, head2[2]);
      container.appendChild(h);
      i++;
      continue;
    }

    if (HR_RE.test(line)) { flushPara(); container.appendChild(el("hr")); i++; continue; }

    if (QUOTE_RE.test(line)) {
      flushPara();
      var quoteLines = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        quoteLines.push(lines[i].replace(QUOTE_RE, ""));
        i++;
      }
      var bq = el("blockquote");
      renderMarkdown(bq, quoteLines.join("\n"));
      container.appendChild(bq);
      continue;
    }

    if (LIST_RE.test(line)) {
      flushPara();
      var parsed = parseListBlock(lines, i);
      container.appendChild(parsed.node);
      i = parsed.next;
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara();
  renderMath(container);
  collapseOldCode(container);
}

// 一条消息里有多块代码时，只展开最后一块，前面的收起
function collapseOldCode(container) {
  var blocks = container.querySelectorAll("pre.collapsible");
  for (var i = 0; i < blocks.length - 1; i++) blocks[i].classList.add("collapsed");
}

/* ---------- 数学公式：本地 KaTeX ---------- */
// 模型输出的 $…$ / $$…$$ / \(…\) / \[…\] 都渲染成公式。
// 公式必须独占一段，避免 $ 被当成普通美元符号误伤；渲染失败就退回等宽源码。
function renderMath(container) {
  if (!window.katex) return;
  var nodes = [];
  // 助手正文按块找；用户气泡是一段纯文本，容器本身就是候选
  var scope = container.querySelectorAll("p, li, td, th, h1, h2, h3, h4, blockquote, .think-body, .turn-body.plain");
  if (container.matches && container.matches(".turn-body.plain")) scope = [container].concat(Array.from(scope));
  Array.from(scope).forEach(function (n) {
    if (!n.firstChild) return;
    var text = n.textContent;
    if (text.indexOf("$") < 0 && text.indexOf("\\(") < 0 && text.indexOf("\\[") < 0) return;
    nodes.push(n);
  });
  nodes.forEach(function (n) {
    // 只处理纯文本节点组成的行，已经渲染过公式的跳过
    if (n.querySelector(".katex")) return;
    var raw = n.textContent;
    var out = mathToFragment(raw);
    if (!out) return;
    while (n.firstChild) n.removeChild(n.firstChild);
    n.appendChild(out);
  });
}

function mathToFragment(raw) {
  var re = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<!\\)\$([^$\n]+?)(?<!\\)\$/g;
  var m, last = 0, frag = document.createDocumentFragment(), hit = false;
  while ((m = re.exec(raw)) !== null) {
    var tex = m[1] || m[2] || m[3] || m[4] || "";
    if (!tex.trim()) continue;
    if (m.index > last) frag.appendChild(document.createTextNode(raw.slice(last, m.index)));
    var display = Boolean(m[1] || m[2]);
    frag.appendChild(mathNode(tex, display));
    last = re.lastIndex;
    hit = true;
  }
  if (!hit) return null;
  if (last < raw.length) frag.appendChild(document.createTextNode(raw.slice(last)));
  return frag;
}

function mathNode(tex, display) {
  try {
    var html = window.katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      strict: false,
      trust: false,
      output: "html"
    });
    var span = document.createElement("span");
    span.className = display ? "math-block" : "math-inline";
    span.innerHTML = html;  // KaTeX 自己转义过输入，这里安全
    return span;
  } catch (err) {
    var fb = document.createElement("span");
    fb.className = "math-fallback";
    fb.textContent = tex;
    return fb;
  }
}


/* ================= 状态 ================= */

// 草稿对话的固定 id（不会出现在服务端，只在左侧列表里临时显示）
var DRAFT_ID = "__draft__";

var state = {
  boot: null,
  settings: {
    model: "", effort: "", system: "", instructions: [], skills: [], mcp: [],
    temperature: 0.7, maxTokens: 0, showReasoning: true
  },
  models: [],
  library: { instructions: [], skills: [], mcp: [] },
  conversations: [],
  messages: [],
  convId: null,
  // 点了"新对话"但还没发消息时，左侧先挂一条草稿；发出第一条就变成真对话，
  // 空着切走就直接丢掉，不在列表里留空壳。
  draft: null,
  // 流式输出时是否跟着往下滚。用户手动往上滑就变 false，滑回底部再变 true。
  follow: true,
  title: "新对话",
  busy: false,
  stopped: false,
  abort: null,
  clientId: "",
  liveRefs: new Set(),
  attachments: [],
  pop: ""
};

// 思考强度的显示名。key 是网关给的原始值（映射不动），只是显示成这些词。
// 注意 xhigh：minimax / qwen 系列会用到，之前漏了会显示成原始串。
var EFFORT_LABEL = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Xhigh", max: "Max" };
function effortLabel(name) { return EFFORT_LABEL[name] || String(name); }

var toastTimer = null;
function toast(text, isError) {
  var box = $("#toast");
  $("#toastText").textContent = text || "";
  box.hidden = !text;
  box.classList.toggle("err", Boolean(isError));
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  if (text) toastTimer = setTimeout(function () { box.hidden = true; }, isError ? 8000 : 3000);
}

/* ================= HTTP ================= */

function api(path, options) {
  var opts = options || {};
  var init = { method: opts.method || "GET", credentials: "omit", cache: "no-store" };
  if (opts.body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(opts.body);
  }
  if (opts.signal) init.signal = opts.signal;
  return fetch(path, init).then(function (res) {
    return res.text().then(function (text) {
      var data = null;
      if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
      if (!res.ok) {
        var msg = (data && (data.error || data.message)) || text.slice(0, 240) || ("HTTP " + res.status);
        throw new Error(msg);
      }
      return data;
    });
  });
}

/* ================= SSE ================= */

function parseEventBlock(block) {
  var lines = block.split(/\r?\n/);
  var eventName = "";
  var dataLines = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.indexOf(":") === 0) continue;
    if (line.indexOf("event:") === 0) { eventName = line.slice(6).trim(); continue; }
    if (line.indexOf("data:") === 0) { dataLines.push(line.slice(5).replace(/^ /, "")); continue; }
  }
  if (!dataLines.length) return null;
  var payload = dataLines.join("\n");
  if (payload === "[DONE]") return { type: "done", ms: 0 };
  var data;
  try { data = JSON.parse(payload); } catch (e) { return null; }
  if (!data || typeof data !== "object") return null;
  if (!data.type && eventName) data.type = eventName;
  return data;
}

function streamChat(payload, onEvent, signal) {
  return fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    credentials: "omit",
    cache: "no-store",
    signal: signal
  }).then(function (res) {
    if (!res.ok) {
      return res.text().then(function (text) {
        var msg = text.slice(0, 300);
        try { var parsed = JSON.parse(text); msg = parsed.error || msg; } catch (e) { /* 原样 */ }
        throw new Error("请求失败：" + (msg || res.status));
      });
    }
    if (!res.body) throw new Error("浏览器不支持流式读取");
    var reader = res.body.getReader();
    var decoder = new TextDecoder("utf-8");
    var buffer = "";
    function pump(block) {
      var evt = parseEventBlock(block);
      if (evt) onEvent(evt);
    }
    function drain() {
      var idx;
      while ((idx = buffer.search(/\r?\n\r?\n/)) >= 0) {
        var block = buffer.slice(0, idx);
        var rest = buffer.slice(idx);
        var sep = /^\r?\n\r?\n/.exec(rest);
        buffer = rest.slice(sep ? sep[0].length : 2);
        if (block.trim()) pump(block);
      }
    }
    function loop() {
      return reader.read().then(function (chunk) {
        if (chunk.done) {
          buffer += decoder.decode();
          if (buffer.trim()) pump(buffer);
          return;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        drain();
        return loop();
      });
    }
    return loop();
  });
}

/* ================= 设置 ================= */

var saveTimer = null;

function currentModel() {
  var list = state.models || [];
  for (var i = 0; i < list.length; i++) if (list[i].id === state.settings.model) return list[i];
  return list[0] || null;
}

function modelLabel(m) {
  if (!m) return "未选择模型";
  return m.name || m.id;
}

function patchSettings(patch) {
  Object.assign(state.settings, patch);
  renderPills();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSettings, 320);
}

function flushSettings() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  return api("/api/settings", { method: "POST", body: state.settings }).then(function (saved) {
    state.settings = Object.assign({}, state.settings, saved || {});
  }).catch(function (err) {
    toast("设置保存失败：" + err.message, true);
  });
}

function applySettings(raw) {
  var s = raw || {};
  state.settings = {
    model: String(s.model || ""),
    effort: String(s.effort || ""),
    system: String(s.system || ""),
    instructions: Array.isArray(s.instructions) ? s.instructions.slice() : [],
    skills: Array.isArray(s.skills) ? s.skills.slice() : [],
    mcp: Array.isArray(s.mcp) ? s.mcp.slice() : [],
    temperature: isFinite(Number(s.temperature)) ? Number(s.temperature) : 0.7,
    maxTokens: isFinite(Number(s.maxTokens)) ? Number(s.maxTokens) : 0,
    showReasoning: s.showReasoning !== false,
    pinned: Array.isArray(s.pinned) ? s.pinned.slice() : [],
    sidebar: s.sidebar !== false,
    settingsOpen: s.settingsOpen === true,
    leftWidth: Number(s.leftWidth) || 0,
    rightWidth: Number(s.rightWidth) || 0,
    convWidth: Number(s.convWidth) || 72,
    composerWidth: Number(s.composerWidth) || 70,
    syncWidth: s.syncWidth === true
  };
}

function renderPills() {
  var model = currentModel();
  $("#modelValue").textContent = state.models.length ? modelLabel(model) : "无可用模型";
  $("#modelBtn").disabled = !state.models.length;
  $("#modelBtn").classList.toggle("on", Boolean(state.settings.model));

  var efforts = (model && Array.isArray(model.efforts)) ? model.efforts : [];
  $("#effortValue").textContent = state.settings.effort ? effortLabel(state.settings.effort) : "默认";
  $("#effortBtn").classList.toggle("on", Boolean(state.settings.effort));
  $("#effortBtn").disabled = !efforts.length;

  var s = state.settings;
  var custom = Boolean(String(s.system || "").trim())
    || (s.instructions || []).length > 0
    || (s.skills || []).length > 0
    || (s.mcp || []).length > 0
    || Number(s.temperature) !== 0.7
    || Number(s.maxTokens) > 0
    || s.showReasoning === false;
  $("#settingsToggle").classList.toggle("set", custom);
}

function renderModelPop() {
  var box = $("#modelPop");
  while (box.firstChild) box.removeChild(box.firstChild);
  if (!state.models.length) {
    box.appendChild(el("div", { class: "set-empty", text: "网关没有返回模型" }));
    return;
  }
  state.models.forEach(function (m) {
    var cur = m.id === state.settings.model;
    var item = el("button", { class: "pop-item" + (cur ? " sel" : ""), type: "button", role: "menuitem", title: m.id },
      el("span", { class: "v", text: modelLabel(m) }),
      el("span", { class: "n", text: [m.provider || "", m.reasoning ? "可思考" : ""].filter(Boolean).join(" · ") || m.id }),
      cur ? el("span", { class: "check", text: "\u2713" }) : null
    );
    item.addEventListener("click", function () {
      state.settings.model = m.id;
      var efforts = m.efforts || [];
      if (state.settings.effort && efforts.indexOf(state.settings.effort) < 0) state.settings.effort = "";
      patchSettings({ model: state.settings.model, effort: state.settings.effort });
      renderPills();
      closePop();
    });
    box.appendChild(item);
  });
}

function renderEffortPop() {
  var box = $("#effortPop");
  while (box.firstChild) box.removeChild(box.firstChild);
  var model = currentModel();
  var efforts = (model && Array.isArray(model.efforts)) ? model.efforts : [];
  if (!efforts.length) {
    box.appendChild(el("div", { class: "set-empty", text: "这个模型没有思考强度" }));
    return;
  }
  var options = [{ value: "", label: "默认" }].concat(efforts.map(function (name) {
    return { value: name, label: effortLabel(name) };
  }));
  options.forEach(function (opt) {
    var cur = (state.settings.effort || "") === opt.value;
    var item = el("button", { class: "pop-item" + (cur ? " sel" : ""), type: "button", role: "menuitem" },
      el("span", { class: "v", text: opt.label }),
      cur ? el("span", { class: "check", text: "\u2713" }) : null
    );
    item.addEventListener("click", function () {
      state.settings.effort = opt.value;
      patchSettings({ effort: opt.value });
      renderPills();
      closePop();
    });
    box.appendChild(item);
  });
}

/* ================= popover ================= */

// popover 现在长在输入框里（按钮在底部），所以一律向上弹，
// 横向贴着按钮右缘对齐、夹在输入区的左右边距里。
function positionPop(pop, btn) {
  var host = $(".composer").getBoundingClientRect();
  var r = btn.getBoundingClientRect();
  pop.style.left = "";
  pop.style.right = "";
  pop.style.top = "";
  pop.style.bottom = "";

  var width = pop.offsetWidth;
  var left = r.right - host.left - width;
  if (left < 8) left = r.left - host.left;
  left = Math.max(8, Math.min(left, host.width - width - 8));
  pop.style.left = Math.round(left) + "px";

  // 向上展开：输入区上缘以上能有多高，就用多高
  var above = r.top - 10;
  pop.style.bottom = "calc(100% + 6px)";
  pop.style.top = "auto";
  pop.style.maxHeight = Math.max(220, Math.round(above)) + "px";
}

function openPop(id, btn) {
  closePop();
  var pop = $("#" + id);
  if (id === "modelPop") renderModelPop();
  if (id === "effortPop") renderEffortPop();
  pop.hidden = false;
  btn.classList.add("on");
  btn.setAttribute("aria-expanded", "true");
  state.pop = id;
  positionPop(pop, btn);
}

function closePop() {
  if (!state.pop) return;
  var pop = $("#" + state.pop);
  if (pop) pop.hidden = true;
  $$(".pill").forEach(function (b) {
    if (b.dataset.pop === state.pop) {
      b.classList.remove("on");
      b.setAttribute("aria-expanded", "false");
    }
  });
  state.pop = "";
}

function bindPopTriggers() {
  // 模型、思考还是向上弹的 popover；设置改成了右侧边栏
  [$("#modelBtn"), $("#effortBtn")].forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var id = btn.id === "modelBtn" ? "modelPop" : "effortPop";
      if (state.pop === id) closePop();
      else openPop(id, btn);
    });
  });

  $("#settingsToggle").addEventListener("click", function (e) {
    e.stopPropagation();
    toggleSettings();
  });


  $$(".pop").forEach(function (pop) {
    pop.addEventListener("click", function (e) { e.stopPropagation(); });
  });

  document.addEventListener("click", function () { closePop(); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (state.pop) { closePop(); return; }
      if (state.busy) stop();
    }
  });
  window.addEventListener("resize", function () {
    if (!state.pop) return;
    var btn = $('[data-pop="' + state.pop + '"]');
    var pop = $("#" + state.pop);
    if (btn && pop) positionPop(pop, btn);
  });
}

/* ================= 设置面板 ================= */

/* ================= 附件（图片 / 文件） ================= */

function readAsDataURL(file) {
  return new Promise(function (resolve, reject) {
    var fr = new FileReader();
    fr.onload = function () { resolve(String(fr.result || "")); };
    fr.onerror = function () { reject(fr.error || new Error("读取失败")); };
    fr.readAsDataURL(file);
  });
}

function guessType(file) {
  if (file.type) return file.type;
  var ext = String(file.name || "").split(".").pop().toLowerCase();
  var map = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf", txt: "text/plain", md: "text/markdown", json: "application/json" };
  return map[ext] || "application/octet-stream";
}

// 一批 File → 加入待发送列表
function addFiles(files) {
  var list = Array.from(files || []).slice(0, 8);
  if (!list.length) return Promise.resolve();
  var jobs = list.map(function (file) {
    var type = guessType(file);
    var isImage = /^image\//.test(type);
    if (file.size > (isImage ? 24 : 8) * 1024 * 1024) {
      toast((isImage ? "图片" : "文件") + "太大：" + (file.name || ""), true);
      return null;
    }
    return readAsDataURL(file).then(function (data) {
      return api("/api/upload", {
        method: "POST",
        body: { name: file.name || "file", type: type, data: data, clientType: type }
      }).catch(function () {
        // 上传接口挂了也还能本地显示：直接按 data URL 用
        return { name: file.name || "file", type: type, kind: isImage ? "image" : "file", size: data.length, data: data };
      });
    });
  }).filter(Boolean);
  return Promise.all(jobs).then(function (out) {
    out.forEach(function (f) { if (f && f.data) state.attachments.push(f); });
    renderAttachments();
  });
}

function renderAttachments() {
  var box = $("#attachList");
  while (box.firstChild) box.removeChild(box.firstChild);
  var list = state.attachments || [];
  box.hidden = !list.length;
  list.forEach(function (f, i) {
    var chip = el("div", { class: "attach", title: f.name || "" });
    if (f.kind === "image") chip.appendChild(el("img", { src: f.data, alt: f.name || "" }));
    else chip.appendChild(el("span", { class: "ic", text: (String(f.name || "F").split(".").pop() || "F").slice(0, 3).toUpperCase() }));
    chip.appendChild(el("span", { class: "nm", text: f.name || "文件" }));
    var rm = el("button", { class: "rm", type: "button", title: "移除", "aria-label": "移除" });
    rm.appendChild(el("span", { text: "\u00d7" }));
    rm.addEventListener("click", function () {
      state.attachments.splice(i, 1);
      renderAttachments();
      updateSend();
    });
    chip.appendChild(rm);
    box.appendChild(chip);
  });
  updateSend();
}

function bindAttachments() {
  var zone = $("#dropZone");
  $("#attachBtn").addEventListener("click", function () { $("#fileInput").click(); });
  $("#fileInput").addEventListener("change", function (e) {
    addFiles(e.target.files);
    e.target.value = "";
  });

  // 拖拽：整页接，落到输入框里
  var depth = 0;
  function isFileDrag(e) {
    var dt = e.dataTransfer;
    if (!dt) return false;
    var types = Array.from(dt.types || []);
    return types.indexOf("Files") >= 0;
  }
  document.addEventListener("dragenter", function (e) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    depth++;
    zone.classList.add("dragging");
    $("#dropHint").hidden = false;
  });
  document.addEventListener("dragover", function (e) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  document.addEventListener("dragleave", function (e) {
    if (!isFileDrag(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) { zone.classList.remove("dragging"); $("#dropHint").hidden = true; }
  });
  document.addEventListener("drop", function (e) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    depth = 0;
    zone.classList.remove("dragging");
    $("#dropHint").hidden = true;
    addFiles(e.dataTransfer.files);
    $("#input").focus();
  });

  // 粘贴：截图直接进附件
  $("#input").addEventListener("paste", function (e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    var files = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === "file") {
        var f = items[i].getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });
}

/* ================= 两侧边栏拖拽调宽 ================= */

var WIDTHS = {
  left: { min: 140, max: 420, key: "leftWidth" },
  right: { min: 240, max: 560, key: "rightWidth" }
};

// 会话内容列与输入框的宽度：设置里存成百分比（会话列另有限制），
// 这里换算成 CSS 变量。会话列 100% 就是铺满。
var CONV_MIN = 560;      // 会话列最窄（px）
var COMPOSER_MIN = 40;   // 输入框最窄（%）

function applyWidths() {
  var s = state.settings;
  if (Number(s.leftWidth)) $("#sessions").style.setProperty("--side-w", clampWidth("left", s.leftWidth) + "px");
  if (Number(s.rightWidth)) $("#settingsPanel").style.setProperty("--set-w", clampWidth("right", s.rightWidth) + "px");
  applyConvWidth(s.convWidth);
  applyComposerWidth(s.composerWidth);
}

// pct 是「占可用宽度的百分比」；100 表示铺满
function applyConvWidth(pct) {
  var v = Number(pct);
  if (!isFinite(v) || v <= 0) v = 72;
  v = Math.max(0, Math.min(100, v));
  var root = document.documentElement;
  if (v >= 100) {
    root.style.setProperty("--conv-w", "100%");
    return;
  }
  // 用 calc 混百分比与最小值：既随窗口缩放，又不会窄到看不清
  root.style.setProperty("--conv-w", "max(" + CONV_MIN + "px, " + v + "%)");
}

function applyComposerWidth(pct) {
  var v = Number(pct);
  if (!isFinite(v) || v <= 0) v = 70;
  v = Math.max(COMPOSER_MIN, Math.min(100, v));
  document.documentElement.style.setProperty("--composer-w", v + "%");
}

// "同步调整"打开时，拖动其中一条把另一条也拉到同一个值
function syncWidthTo(from, v) {
  var n = Math.round(Number(v) || 0);
  // 两个都要记在 state 里：拖动过程中只改 DOM，等松手才 patchSettings，
  // 这里不记的话同步读到的是上一次的值。
  state.settings.convWidth = n;
  state.settings.composerWidth = n;
  applyConvWidth(n);
  applyComposerWidth(n);
  $("#convWidth").value = String(n);
  $("#composerWidth").value = String(n);
  $("#convWidthValue").textContent = n >= 100 ? "铺满" : n + "%";
  $("#composerWidthValue").textContent = n + "%";
}

function clampWidth(side, v) {
  var w = WIDTHS[side];
  return Math.max(w.min, Math.min(w.max, Math.round(Number(v) || w.min)));
}

function bindResizers() {
  [["#leftResizer", "left", "#sessions"], ["#rightResizer", "right", "#settingsPanel"]].forEach(function (cfg) {
    var bar = $(cfg[0]), target = $(cfg[2]);
    if (!bar || !target) return;
    var dragging = false, startX = 0, startW = 0;

    function down(e) {
      // 只接主键（mousedown 的 e.button 是 0；有些合成事件不带）
      if (typeof e.button === "number" && e.button !== 0) return;
      dragging = true;
      startX = e.clientX != null ? e.clientX : 0;
      startW = target.getBoundingClientRect().width;
      bar.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    }
    function move(e) {
      if (!dragging) return;
      var dx = (e.clientX != null ? e.clientX : 0) - startX;
      var next = clampWidth(cfg[1], cfg[1] === "left" ? startW + dx : startW - dx);
      target.style.setProperty(cfg[1] === "left" ? "--side-w" : "--set-w", next + "px");
      e.preventDefault();
    }
    function up() {
      if (!dragging) return;
      dragging = false;
      bar.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      var w = Math.round(target.getBoundingClientRect().width);
      var key = WIDTHS[cfg[1]].key;
      state.settings[key] = w;
      api("/api/settings", { method: "POST", body: { [key]: w } }).catch(function () {});
    }

    bar.addEventListener("mousedown", down);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    // 键盘也能调：左右方向键
    bar.addEventListener("keydown", function (e) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      var cur = Math.round(target.getBoundingClientRect().width);
      var step = (e.key === "ArrowRight" ? 1 : -1) * (cfg[1] === "left" ? 1 : -1) * 16;
      var next = clampWidth(cfg[1], cur + step);
      target.style.setProperty(cfg[1] === "left" ? "--side-w" : "--set-w", next + "px");
      var key = WIDTHS[cfg[1]].key;
      state.settings[key] = next;
      api("/api/settings", { method: "POST", body: { [key]: next } }).catch(function () {});
    });
  });
}

/* 设置：右侧独立边栏，开着就显示，状态记在设置里 */
// 右侧设置栏：settingsOpen 表示「它开着」，收起只是视觉上收成 0 宽，
// 和左侧栏一样带过渡，收起后只在右上角留一个浮动按钮。
function toggleSettings(open, persist) {
  var app = $("#app");
  // 当前是不是「真的开着」：面板显示着，且没有处于收起态。
  // 只看 class 会把「从没开过」（panel.hidden 为 true、没有 set-off）
  // 误判成开着的，于是点了去关，被下面的守卫直接 return，按钮就失灵了。
  var isOpen = !$("#settingsPanel").hidden && !app.classList.contains("set-off");
  var show = typeof open === "boolean" ? open : !isOpen;
  $("#settingsPanel").hidden = false;
  app.classList.toggle("set-off", !show);
  var toggle = $("#settingsToggle");
  toggle.classList.toggle("on", show);
  toggle.setAttribute("aria-expanded", show ? "true" : "false");
  toggle.title = show ? "收起设置栏" : "展开设置栏";
  toggle.setAttribute("aria-label", toggle.title);
  state.settings.settingsOpen = show;
  // 恢复上次状态时不要再写回去，否则会把用户刚改的值覆盖成旧的
  if (persist !== false) {
    api("/api/settings", { method: "POST", body: { settingsOpen: show } }).catch(function () {});
  }
  if (show) renderSettings();
}

function renderSettings() {
  $("#systemInput").value = state.settings.system || "";
  $("#convWidth").value = String(Math.round(Number(state.settings.convWidth) || 72));
  $("#convWidthValue").textContent = (Number(state.settings.convWidth) || 72) >= 100 ? "铺满" : Math.round(Number(state.settings.convWidth) || 72) + "%";
  $("#composerWidth").value = String(Math.round(Number(state.settings.composerWidth) || 70));
  $("#composerWidthValue").textContent = Math.round(Number(state.settings.composerWidth) || 70) + "%";
  $("#temperature").value = String(state.settings.temperature);
  $("#tempValue").textContent = Number(state.settings.temperature).toFixed(2);
  $("#maxTokens").value = String(state.settings.maxTokens || 0);
  $("#showReasoning").setAttribute("aria-checked", state.settings.showReasoning ? "true" : "false");
  $("#syncWidth").setAttribute("aria-checked", state.settings.syncWidth ? "true" : "false");
  renderSetList("#instructionList", state.library.instructions || [], "instructions", function (item) {
    return { key: item.id || item.name, name: item.name || item.id, extra: item.size ? item.size + " B" : "" };
  });
  renderSetList("#skillList", state.library.skills || [], "skills", function (item) {
    return { key: item.name, name: item.name, extra: "" };
  });
  renderSetList("#mcpList", state.library.mcp || [], "mcp", function (item) {
    return { key: item.name, name: item.name, extra: item.transport || "" };
  });
}

function renderSetList(sel, items, field, pick) {
  var box = $(sel);
  while (box.firstChild) box.removeChild(box.firstChild);
  if (!items.length) {
    box.appendChild(el("div", { class: "set-empty", text: field === "mcp" ? "没有配置 MCP 服务器" : "没有可选项" }));
    return;
  }
  var selected = state.settings[field] || [];
  items.forEach(function (item) {
    var info = pick(item);
    var on = selected.indexOf(info.key) >= 0;
    var tick = el("span", { class: "tick" + (on ? " on" : ""), text: "\u2713" });
    var row = el("button", { class: "set-item", type: "button", role: "checkbox", "aria-checked": on ? "true" : "false", title: info.name },
      tick,
      el("span", { class: "set-name", text: info.name }),
      info.extra ? el("span", { class: "set-extra", text: info.extra }) : null
    );
    row.addEventListener("click", function () { toggleItem(field, info.key); });
    box.appendChild(row);
  });
}

function toggleItem(field, key) {
  var list = (state.settings[field] || []).slice();
  var at = list.indexOf(key);
  if (at >= 0) list.splice(at, 1); else list.push(key);
  var patch = {};
  patch[field] = list;
  patchSettings(patch);
  renderSettings();
  if (field === "mcp") {
    $("#toolsStatus").textContent = "";
    $("#toolsStatus").className = "set-tools-status";
  }
}

function checkTools() {
  var status = $("#toolsStatus");
  status.textContent = "检查中…";
  status.className = "set-tools-status";
  $("#checkTools").disabled = true;
  api("/api/mcp/tools").then(function (data) {
    var servers = (data && data.servers) || [];
    if (!servers.length) { status.textContent = "没有启用的服务器"; return; }
    var ok = servers.filter(function (s) { return s.ok; });
    var bad = servers.filter(function (s) { return !s.ok; });
    if (bad.length) {
      status.textContent = bad[0].name + " 连接失败";
      status.className = "set-tools-status err";
      status.title = String(bad[0].error || "");
      return;
    }
    var total = ok.reduce(function (sum, s) { return sum + ((s.tools || []).length); }, 0);
    status.textContent = ok.length + " 个服务器 · " + total + " 个工具";
    status.className = "set-tools-status ok";
  }).catch(function (err) {
    status.textContent = "检查失败：" + err.message;
    status.className = "set-tools-status err";
  }).then(function () { $("#checkTools").disabled = false; });
}

/* ================= 会话列表 ================= */

function loadConversations() {
  return api("/api/conversations").then(function (data) {
    state.conversations = (data && data.items) || [];
    renderSessions();
  }).catch(function (err) {
    console.warn("读取对话列表失败", err);
  });
}

function renderSessions() {
  var box = $("#sessionList");
  while (box.firstChild) box.removeChild(box.firstChild);

  var items = state.conversations.slice();
  // 草稿（刚点"新对话"、还没发消息）排在最前，标题就叫"新对话"
  if (state.draft) items.unshift(state.draft);

  if (!items.length) {
    box.appendChild(el("div", { class: "sess-empty", text: "还没有保存的对话" }));
    return;
  }

  items.forEach(function (item) {
    if (item.id === DRAFT_ID) {
      // 草稿：没写字时叫"新对话"，一发送就把刚输入的内容当标题（没有置顶和删除）
      var dbtn = el("button", {
        class: "sess" + (state.convId ? "" : " on"),
        type: "button",
        title: item.title || "新对话"
      },
        el("span", { class: "sess-title", text: item.title || "新对话" }),
        el("span", { class: "sess-time", text: "刚刚" })
      );
      box.appendChild(dbtn);
      return;
    }
    var on = item.id === state.convId;
    var pinned = Boolean(item.pinned);

    var pinBtn = el("button", {
      class: "sess-act" + (pinned ? " pinned" : ""),
      type: "button",
      title: pinned ? "取消置顶" : "置顶",
      "aria-label": pinned ? "取消置顶" : "置顶"
    }, el("span", { text: pinned ? "\u2605" : "\u2606" }));

    var delBtn = el("button", { class: "sess-act", type: "button", title: "删除", "aria-label": "删除" },
      el("span", { text: "\u00d7" }));

    // 重命名：铅笔图标。按钮里塞不下 input（button 不能嵌交互元素），
    // 编辑时把这个条目整体换成一个输入框，提交/取消再换回来。
    var renameBtn = el("button", { class: "sess-act", type: "button", title: "重命名", "aria-label": "重命名" });
    renameBtn.innerHTML = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M10.7 2.5a1.3 1.3 0 0 1 1.9 0l.9.9a1.3 1.3 0 0 1 0 1.9l-7.4 7.4-2.7.7.7-2.7z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';

    var btn = el("button", { class: "sess" + (on ? " on" : ""), type: "button", title: item.title || "对话" },
      pinned ? el("span", { class: "sess-pin", text: "\u2605" }) : null,
      el("span", { class: "sess-title", text: item.title || "未命名" }),
      el("span", { class: "sess-time", text: relTime(item.updated) }),
      el("span", { class: "sess-acts" }, pinBtn, renameBtn, delBtn)
    );
    // 条目本身是 <button>，里面的操作也是 <button>；点它们要拦住冒泡，别顺带打开对话
    pinBtn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      togglePin(item.id, !pinned);
    });
    delBtn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      askDelete(item.id, item.title);
    });
    renameBtn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      startRename(item.id, btn, item.title || "未命名");
    });
    btn.addEventListener("click", function () { openConversation(item.id); });
    box.appendChild(btn);
  });
}

/* 置顶：列表顺序由服务端按 pinned 排，这里只改设置再重读 */
function togglePin(id, pin) {
  var pinned = (state.settings.pinned || []).slice();
  var at = pinned.indexOf(id);
  if (pin && at < 0) pinned.push(id);
  if (!pin && at >= 0) pinned.splice(at, 1);
  state.settings.pinned = pinned;
  api("/api/settings", { method: "POST", body: { pinned: pinned } })
    .then(function () { return loadConversations(); })
    .then(function () { toast(pin ? "已置顶" : "已取消置顶"); })
    .catch(function (err) { toast("置顶失败：" + err.message, true); });
}

/* 重命名：把整个条目换成一个输入框，回车/失焦保存，Esc 取消 */
function startRename(id, rowEl, oldTitle) {
  var input = el("input", { class: "sess-rename", type: "text", "aria-label": "重命名对话" });
  input.value = oldTitle || "";
  rowEl.parentNode.insertBefore(input, rowEl.nextSibling);
  rowEl.style.display = "none";
  input.focus();
  input.select();

  var done = false;
  function finish(save) {
    if (done) return;
    done = true;
    var val = input.value.trim().replace(/\s+/g, " ");
    if (input.parentNode) input.parentNode.removeChild(input);
    rowEl.style.display = "";
    if (!save || !val || val === oldTitle) return;
    api("/api/conversations/" + encodeURIComponent(id), { method: "PATCH", body: { title: val } })
      .then(function () { return loadConversations(); })
      .catch(function (err) { toast("重命名失败：" + err.message, true); });
  }

  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", function () { finish(true); });
  input.addEventListener("click", function (e) { e.stopPropagation(); });
}

/* 删除：点了就删（不弹确认），删掉正在看的那条就回到空态 */
function askDelete(id, title) {
  var name = String(title || "这条对话");
  {
    api("/api/conversations/" + encodeURIComponent(id), { method: "DELETE" }).then(function () {
      // 置顶列表里也把它去掉，免得留下悬空的 id
      var pinned = (state.settings.pinned || []).filter(function (x) { return x !== id; });
      state.settings.pinned = pinned;
      api("/api/settings", { method: "POST", body: { pinned: pinned } }).catch(function () {});
      if (state.convId === id) {
        state.convId = null;
        state.title = "新对话";
        state.messages = [];
        renderMessages();
        renderSessions();
      } else {
        loadConversations();
      }
      toast("已删除「" + name.slice(0, 20) + "」");
    }).catch(function (err) {
      toast("删除失败：" + err.message, true);
    });
  }
}

/* 侧栏收起 / 展开，状态存在设置里，下次打开还是那样 */
function setSidebar(open) {
  $("#app").classList.toggle("side-off", !open);
  state.settings.sidebar = open;
  api("/api/settings", { method: "POST", body: { sidebar: open } }).catch(function () {});
}

function openConversation(id) {
  if (state.busy) { toast("正在生成，先停止再切换对话", true); return; }
  dropBlankDraft(); // 切换到别的对话时，空着的"新对话"不该留在列表里
  api("/api/conversations/" + encodeURIComponent(id)).then(function (conv) {
    if (!conv) return;
    state.convId = conv.id;
    state.title = conv.title || "新对话";
    state.messages = (conv.messages || []).map(normalizeMessage);
    renderMessages();
    renderSessions();
    scrollBottom(true);
  }).catch(function (err) {
    toast("打开对话失败：" + err.message, true);
  });
}

function normalizeMessage(m) {
  return {
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content || ""),
    reasoning: String(m.reasoning || ""),
    toolCalls: Array.isArray(m.toolCalls) ? m.toolCalls.map(function (c) {
      return {
        id: c.id || "", name: c.name || "",
        args: c.args === undefined ? "" : c.args,
        result: c.result === undefined ? "" : c.result,
        isError: Boolean(c.isError)
      };
    }) : [],
    files: Array.isArray(m.files) ? m.files.slice() : [],
    usage: m.usage || null,
    model: m.model || "",
    stopped: Boolean(m.stopped),
    ms: Number(m.ms || 0),
    // 这一轮"从按下发送到回答完"的耗时，重新打开对话时底部那行要显示它
    forageMs: Number(m.forageMs || 0),
    error: ""
  };
}

function persistConversation() {
  if (!state.messages.length) return Promise.resolve();
  var payload = {
    id: state.convId || undefined,
    title: state.title || undefined,
    messages: state.messages.map(function (m) {
      return {
        role: m.role,
        content: m.content || "",
        reasoning: m.reasoning || "",
        toolCalls: (m.toolCalls || []).map(function (c) {
          return { id: c.id, name: c.name, args: c.args, result: c.result, isError: Boolean(c.isError) };
        }),
        files: (m.files || []).length ? m.files : undefined,
        usage: m.usage || undefined,
        model: m.model || undefined,
        stopped: m.stopped || undefined,
        ms: m.ms || 0,
        forageMs: m.forageMs || 0
      };
    })
  };
  return api("/api/conversations", { method: "POST", body: payload }).then(function (saved) {
    if (!saved) return;
    state.convId = saved.id;
    state.title = saved.title || state.title;
    state.draft = null; // 已经是真对话了，草稿退场
    return loadConversations();
  }).catch(function (err) {
    toast("对话保存失败：" + err.message, true);
  });
}

/* ================= 消息渲染 ================= */

// 浮层滚动条：照 magpie 自己的做法（app.css 的 .side-bar / app.js 的 sideBars）。
// 原生滚动条全程隐藏，这里画一个 6px 的圆角条，滚动时露出、停手后淡出，还能拖动。
var barState = { fadeTimer: null, hideTimer: null, dragging: false, startY: 0, startTop: 0 };

function scrollBarEls() {
  var wrap = $("#streamWrap");
  var bar = $("#scrollBar");
  return { wrap: wrap, bar: bar, thumb: bar ? bar.querySelector("i") : null };
}

// 依据当前滚动位置算出滑块的高度与位置；不需要滚动时隐藏
function paintScrollBar() {
  var stream = $("#stream");
  var e = scrollBarEls();
  if (!stream || !e.bar || !e.thumb || !e.wrap) return;
  var viewH = e.wrap.clientHeight;
  var trackH = Math.max(0, viewH - 8); // 上下各留 4px，和 magpie 的 right:4px 对齐
  var ratio = stream.clientHeight / stream.scrollHeight;
  if (stream.scrollHeight <= stream.clientHeight + 1) {
    e.bar.hidden = true;
    e.bar.classList.remove("on");
    return;
  }
  e.bar.hidden = false;
  e.bar.style.top = "4px";
  e.bar.style.height = trackH + "px";
  var thumbH = Math.max(24, Math.round(trackH * ratio));
  e.thumb.style.height = thumbH + "px";
  var maxTop = trackH - thumbH;
  var top = stream.scrollHeight > stream.clientHeight
    ? (stream.scrollTop / (stream.scrollHeight - stream.clientHeight)) * maxTop
    : 0;
  e.thumb.style.top = Math.max(0, Math.min(maxTop, top)) + "px";
}

// 滚动时露出，停手 1.2 秒后淡出（magpie 的过渡是 .35s + .1s 延迟）
function flashScrollBar() {
  var e = scrollBarEls();
  if (!e.bar) return;
  paintScrollBar();
  if (e.bar.hidden) return;
  e.bar.classList.add("on");
  if (barState.fadeTimer) clearTimeout(barState.fadeTimer);
  barState.fadeTimer = setTimeout(function () {
    if (!barState.dragging) e.bar.classList.remove("on");
    barState.fadeTimer = null;
  }, 1200);
}

// 拖动滑块
function bindScrollBarDrag() {
  var e = scrollBarEls();
  if (!e.bar || !e.thumb) return;
  e.bar.addEventListener("mousedown", function (ev) {
    var stream = $("#stream");
    if (!stream || ev.button !== 0) return;
    var rect = e.thumb.getBoundingClientRect();
    var onThumb = ev.clientY >= rect.top && ev.clientY <= rect.bottom;
    if (!onThumb) {
      // 点空白处：让滑块跳到指针位置
      var barRect = e.bar.getBoundingClientRect();
      var frac = (ev.clientY - barRect.top) / Math.max(1, barRect.height);
      stream.scrollTop = frac * (stream.scrollHeight - stream.clientHeight);
      flashScrollBar();
      return;
    }
    barState.dragging = true;
    barState.startY = ev.clientY;
    barState.startTop = stream.scrollTop;
    e.bar.classList.add("drag");
    ev.preventDefault();
  });
  document.addEventListener("mousemove", function (ev) {
    if (!barState.dragging) return;
    var stream = $("#stream");
    if (!stream) return;
    var trackH = Math.max(0, e.bar.clientHeight - 8);
    var thumbH = e.thumb.offsetHeight;
    var maxTop = Math.max(1, trackH - thumbH);
    var maxScroll = stream.scrollHeight - stream.clientHeight;
    stream.scrollTop = barState.startTop + ((ev.clientY - barState.startY) / maxTop) * maxScroll;
  });
  document.addEventListener("mouseup", function () {
    if (!barState.dragging) return;
    barState.dragging = false;
    e.bar.classList.remove("drag");
    flashScrollBar();
  });
}

// 距底部多少像素以内算"还在跟着看"
var FOLLOW_GAP = 40;

function nearBottom(box) {
  if (!box) return true;
  return box.scrollHeight - box.scrollTop - box.clientHeight <= FOLLOW_GAP;
}

// force=true：无条件回到底部并恢复跟随（发消息、切对话时用）
// force=false：只有"还在跟随"时才滚。用户自己往上滑过就不再拽回来。
function scrollBottom(force) {
  var box = $("#stream");
  if (!box) return;
  if (force) {
    state.follow = true;
    box.scrollTop = box.scrollHeight;
    return;
  }
  if (state.follow === false) return;
  // 这里不要再判 nearBottom：流式输出每帧都在长高，"距底"天然会变大，
  // 实时判会把"正是自己在往下写"误判成"用户滚走了"，于是永远不跟。
  // follow 状态由 scroll / wheel / touchmove 那三个监听维护。
  box.scrollTop = box.scrollHeight;
}

function renderMessages() {
  var box = $("#stream");
  while (box.firstChild) box.removeChild(box.firstChild);
  state.liveRefs.forEach(function (refs) { refs.live = false; });
  state.liveRefs.clear();
  if (!state.messages.length) {
    box.appendChild(emptyState());
    return;
  }
  state.messages.forEach(function (msg) { box.appendChild(buildTurn(msg).root); });
}

function emptyState() {
  var sugs = ["用一句话说说 magpie chat 能做什么", "帮我写个 PowerShell 批量重命名脚本", "把这段函数拆成三个小函数"];
  return el("div", { class: "empty-state" },
    el("b", { text: "开始一段对话" }),
    el("p", { text: "模型和思考强度在输入框右下角；历史对话在左侧，可以收起。" }),
    el("div", { class: "empty-sugs" }, sugs.map(function (text) {
      return el("button", { class: "sug", type: "button", text: text, onclick: function () {
        var input = $("#input");
        input.value = text;
        autoGrow();
        updateSend();
        input.focus();
      } });
    }))
  );
}

// 用户消息不标注名字；助手只显示模型名（有图标就带上）
function turnLabelFor(msg) {
  if (msg.role === "user") return "";
  if (msg.model) {
    var hit = (state.models || []).find(function (m) { return m.id === msg.model; });
    return hit ? modelLabel(hit) : String(msg.model).split("/").pop();
  }
  var cur = currentModel();
  return cur ? modelLabel(cur) : "助手";
}

function modelIconFor(msg) {
  var id = msg && msg.model;
  var hit = id ? (state.models || []).find(function (m) { return m.id === id; }) : currentModel();
  return hit && hit.icon ? hit.icon : "";
}

// 一条消息里的附件（图片缩略图 / 文件条）
function mediaBlock(files, opts) {
  var list = (files || []).filter(function (f) { return f && f.data; });
  if (!list.length) return null;
  var wrap = el("div", { class: "msg-media" });
  list.forEach(function (f) {
    if (f.kind === "image") {
      var img = el("img", { src: f.data, alt: f.name || "图片", title: f.name || "" });
      img.addEventListener("click", function () { lightbox(f.data, f.name); });
      wrap.appendChild(img);
    } else {
      wrap.appendChild(el("span", { class: "msg-file", title: f.name || "" },
        el("span", { class: "nm", text: f.name || "文件" }),
        el("span", { class: "hint", text: f.size ? fmtBytes(f.size) : "" })
      ));
    }
  });
  return wrap;
}

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

function lightbox(src, name) {
  var box = el("div", { class: "lightbox", role: "dialog", "aria-modal": "true" },
    el("img", { src: src, alt: name || "图片" }));
  box.addEventListener("click", function () { box.remove(); });
  document.addEventListener("keydown", function onKey(e) {
    if (e.key === "Escape") { box.remove(); document.removeEventListener("keydown", onKey); }
  });
  document.body.appendChild(box);
}

function buildTurn(msg, animate) {
  var root = el("div", { class: "turn " + msg.role + (animate ? " enter" : "") });
  var name = turnLabelFor(msg);
  var icon = modelIconFor(msg);
  var label = el("span", { class: "turn-label" });
  // 图标由服务端给（没有图片文件的供应商，服务端会画一个首字母 SVG）
  if (icon) label.appendChild(el("img", { src: icon, alt: "" }));
  if (name) label.appendChild(el("span", { text: name }));
  var meta = el("span", { class: "turn-meta" });
  var who = el("div", { class: "turn-who" }, label, meta);
  // 用户消息没有名字就不显示那一行（只保留 meta）
  if (msg.role === "user" && !name && !meta.textContent) who.hidden = true;
  root.appendChild(who);

  if (msg.role === "user") {
    // 图片和文字一起在同一个气泡里
    var bubble = el("div", { class: "turn-body plain" });
    var media = mediaBlock(msg.files);
    if (media) bubble.appendChild(media);
    if (msg.content) {
      var text = el("div", { class: "bubble-text" });
      text.style.whiteSpace = "pre-wrap";
      text.textContent = msg.content;
      // 用户自己写进去的公式也渲染（$…$ / $$…$$），渲染不了就保持原文
      try { renderMath(text); } catch (err) { /* 保持纯文本 */ }
      bubble.appendChild(text);
    }
    root.appendChild(bubble);
    return { root: root, msg: msg, label: label, meta: meta, body: bubble, dirty: false };
  }

  var think = el("details", { class: "think" },
    el("summary", null, el("span", { class: "caret", text: "\u25B6" }), el("span", { text: "思考过程" })),
    el("div", { class: "think-body" })
  );
  think.hidden = !msg.reasoning || state.settings.showReasoning === false;
  think.querySelector(".think-body").textContent = msg.reasoning || "";
  // 只有「用户真的点了」才算他展开过。代码里设 open 也会异步触发 toggle，
  // 所以设 open 之前打一个 program 标记，那一次事件直接放过。
  think.addEventListener("toggle", function () {
    if (think.dataset.program === "1") { delete think.dataset.program; return; }
    if (think.dataset.live === "1") think.dataset.user = "1";
  });
  root.appendChild(think);

  var talks = el("div", { class: "talks" });
  var cards = {};
  (msg.toolCalls || []).forEach(function (call) {
    var card = makeTalk(call);
    if (call.result) card.done();
    cards[call.id] = card;
    talks.appendChild(card.root);
  });
  root.appendChild(talks);

  var bodyMd = el("div", { class: "turn-body md" });
  renderMarkdown(bodyMd, msg.content || "");
  root.appendChild(bodyMd);

  var err = el("div", { class: "turn-error", hidden: true });
  if (msg.error) { err.textContent = msg.error; err.hidden = false; }
  root.appendChild(err);

  var copy = el("button", { class: "mini", type: "button", text: "复制" });
  copy.addEventListener("click", function () { copyText(msg.content || ""); });
  var actions = el("div", { class: "turn-actions" }, copy);
  actions.hidden = !msg.content;
  root.appendChild(actions);

  // 这一轮的模型状态，压在这一侧消息的最底下（就是"复制"下面那一行）
  var forage = el("div", { class: "turn-forage", hidden: true });
  root.appendChild(forage);

  var refs = {
    root: root, msg: msg, label: label, meta: meta, think: think,
    thinkBody: think.querySelector(".think-body"), talks: talks, cards: cards,
    body: bodyMd, err: err, actions: actions, copy: copy, forage: forage, dirty: false
  };
  // 老对话（重新打开时）：把当时的结果直接画出来
  if (msg.error) paintTurnForage(refs, "fail", "Magpie没有找到食物", null);
  else if (msg.forageMs || msg.ms) paintTurnForage(refs, "done", "Magpie找到了食物！", msg.forageMs || msg.ms);
  updateMeta(refs);
  return refs;
}

// 标签 = 图标 + 模型名；用户轮没有标签
function updateLabel(refs) {
  var msg = refs.msg;
  var label = refs.label;
  while (label.firstChild) label.removeChild(label.firstChild);
  if (msg.role === "user") return;
  var icon = modelIconFor(msg);
  if (icon) label.appendChild(el("img", { src: icon, alt: "" }));
  var name = turnLabelFor(msg);
  if (name) label.appendChild(el("span", { text: name }));
}

function updateMeta(refs) {
  var msg = refs.msg;
  var parts = [];
  if (msg.stopped) parts.push("已停止");
  if (msg.ms) parts.push(fmtTime(msg.ms));
  if (msg.usage && (msg.usage.total_tokens || msg.usage.prompt_tokens || msg.usage.completion_tokens)) {
    parts.push(fmtNum(msg.usage.prompt_tokens) + " → " + fmtNum(msg.usage.completion_tokens) + " tokens");
  }
  var calls = (msg.toolCalls || []).length;
  if (calls) parts.push(calls + " 次工具");
  refs.meta.textContent = parts.join(" · ");
  refs.actions.hidden = !msg.content;
  updateLabel(refs);
}

function makeTalk(call) {
  var stateEl = el("span", { class: "talk-state", text: "调用中…" });
  var body = el("div", { class: "talk-body" });
  var root = el("details", { class: "talk" },
    el("summary", null,
      el("span", { class: "caret", text: "\u25B6" }),
      el("span", { class: "talk-name", text: call.name || "工具" }),
      stateEl
    ),
    body
  );
  function renderBody() {
    while (body.firstChild) body.removeChild(body.firstChild);
    if (call.args !== undefined && call.args !== null && call.args !== "") {
      body.appendChild(el("div", { class: "talk-k", text: "参数" }));
      body.appendChild(el("pre", { text: prettyArgs(call.args) }));
    }
    if (call.result) {
      body.appendChild(el("div", { class: "talk-k", text: call.isError ? "错误" : "结果" }));
      body.appendChild(el("pre", { text: String(call.result) }));
    }
    if (!body.firstChild) body.appendChild(el("div", { class: "talk-k", text: "等待结果…" }));
  }
  renderBody();
  root.querySelector(".caret");
  return {
    root: root,
    body: body,
    call: call,
    renderBody: renderBody,
    done: function () {
      stateEl.textContent = call.isError ? "失败" : "完成";
      stateEl.className = "talk-state " + (call.isError ? "err" : "ok");
      renderBody();
      if (call.isError) root.open = true;
    }
  };
}

function prettyArgs(args) {
  if (typeof args === "string") {
    try { return JSON.stringify(JSON.parse(args), null, 2); } catch (e) { return args; }
  }
  try { return JSON.stringify(args, null, 2); } catch (e) { return String(args); }
}

function copyText(text) {
  function fallback() {
    var ta = el("textarea", { style: "position:fixed;left:-9999px;top:0" });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () {
      toast("已复制", false);
    }).catch(function () {
      var ok = fallback();
      toast(ok ? "已复制" : "复制失败，请手动选择文本", !ok);
    });
    return;
  }
  var done = fallback();
  toast(done ? "已复制" : "复制失败，请手动选择文本", !done);
}

/* ================= 流式调度 ================= */

var rafPending = false;

function scheduleMarkdown(refs) {
  refs.dirty = true;
  state.liveRefs.add(refs);
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(function () {
    rafPending = false;
    state.liveRefs.forEach(function (item) {
      if (!item.dirty) return;
      item.dirty = false;
      renderMarkdown(item.body, item.msg.content);
      if (!item.caret) {
        item.caret = el("span", { class: "streaming-caret" });
        item.body.appendChild(item.caret);
      }
    });
    scrollBottom(false);
  });
}

/* ---------- 流式"打字机"：把一次收到的一大块按帧均匀放出来 ----------
   网关的 delta 经常是一句话甚至一段一起到，直接渲染就是一格一格跳。
   这里先把内容压进 msg.pending，每帧只放几个字，文字就是连续流出来的。 */
var pumpRaf = 0;
var pumpQueue = new Set();

function pumpKick() {
  if (!pumpRaf) pumpRaf = requestAnimationFrame(pumpTick);
}

function pumpTick() {
  pumpRaf = 0;
  var live = false;
  var now = (typeof performance !== "undefined" ? performance.now() : Date.now());
  pumpQueue.forEach(function (refs) {
    var msg = refs.msg;
    var pend = msg.pending || "";
    if (!pend) return;
    live = true;

    // 分两种情况：
    //   流式：网关一个字一个字给，积压一直很小 → 匀速走，手感最稳。
    //   非流式：某些模型一次把整段吐出来，积压一下几百上千字 →
    //           按"剩余时间"倒推每帧该放多少，保证 1 秒内流完。
    var take;
    // 进了"大块模式"就一直按进度走，直到这段文字放完 ——
    // 不能等积压掉到 120 以下就切回慢速，那样最后一百多字会被拖成好几秒。
    if (pend.length > 120 || msg.burstMode) {
      if (!msg.burstMode) {
        msg.burstMode = true;
        // 从"收到第一段文字"那一刻开始计时，而不是从第一次渲染算 ——
        // 中间隔着建 DOM、等 rAF 的时间，从渲染算会整体晚一拍。
        msg.burstStart = msg.streamStartedAt || now;
        msg.burstTotal = msg.content.length + pend.length;
      }
      // 按时间线性推进：progress 是已过的时间比例，target 是该显示到第几个字。
      // 不看帧率，30fps 还是 120fps，1 秒到的瞬间都正好放完。
      var progress = Math.min(1, (now - msg.burstStart) / 1000);
      var target = Math.ceil(msg.burstTotal * progress);
      take = Math.max(3, target - msg.content.length);
    } else {
      // 真正的流式：匀速，手感最稳
      take = pend.length > 80 ? 6 : 3;
    }
    take = Math.min(pend.length, Math.max(3, take));
    msg.content += pend.slice(0, take);
    msg.pending = pend.slice(take);
    renderStreaming(refs.body, msg.content);
    // 光标复用同一个元素，只在第一次挂上去（每帧删了重建同样会造成 DOM 抖动）
    if (!refs.caret) refs.caret = el("span", { class: "streaming-caret" });
    var tailEl = refs.body.lastChild;
    if (tailEl && refs.caret.parentNode !== tailEl) tailEl.appendChild(refs.caret);
    if (!msg.pending) {
      // 必须把光标元素从 DOM 里摘掉。只把 refs.caret 置 null 的话，
      // 最后那一帧 append 上去的 span 会一直留在正文末尾 ——
      // 就是那个 6×12、背景是主题色的紫色小方块。
      if (refs.caret && refs.caret.parentNode) refs.caret.parentNode.removeChild(refs.caret);
      refs.caret = null;
      pumpQueue.delete(refs);
      msg.burstMode = false; // 这段放完了，下一轮重新判断是流式还是一次性
      msg.burstStart = 0;
      msg.burstTotal = 0;
    }
  });
  if (live) scrollBottom(false);
  if (pumpQueue.size) pumpRaf = requestAnimationFrame(pumpTick);
}

// 这一轮结束了：把还没放完的一次性倒出来，别让结尾缺字
function pumpFlush(refs) {
  var msg = refs && refs.msg;
  if (!msg) return;
  if (msg.pending) {
    msg.content += msg.pending;
    msg.pending = "";
  }
  msg.burstMode = false;
  msg.burstStart = 0;
  msg.burstTotal = 0;
  pumpQueue.delete(refs);
  if (refs.caret && refs.caret.parentNode) refs.caret.parentNode.removeChild(refs.caret);
  refs.caret = null;
}

/* ================= 发送 / 停止 ================= */

function autoGrow() {
  var input = $("#input");
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 180) + "px";
}

function updateSend() {
  var btn = $("#send");
  var input = $("#input");
  $("#app").classList.toggle("busy", state.busy);
  btn.disabled = state.busy ? false : (!input.value.trim() && !(state.attachments || []).length);
  btn.setAttribute("aria-label", state.busy ? "停止生成" : "发送");
  input.title = state.busy ? "生成中…（Esc 停止）" : "Enter 发送 · Shift+Enter 换行";
}

function send() {
  if (state.busy) { stop(); return; }
  var input = $("#input");
  var text = input.value.trim();
  if (!text && !(state.attachments || []).length) return;
  if (!state.settings.model) { toast("先选一个模型", true); return; }

  var files = (state.attachments || []).map(function (f) {
    return { name: f.name, type: f.type, kind: f.kind, size: f.size, data: f.data };
  });
  var userMsg = { role: "user", content: text, reasoning: "", toolCalls: [], files: files };
  state.attachments = [];
  renderAttachments();
  var asstMsg = {
    role: "assistant", content: "", reasoning: "", toolCalls: [],
    usage: null, ms: 0, error: "", model: state.settings.model, stopped: false,
    // 这一轮第一次收到文字的时刻，用来判断"一次性输出"时该用多快的流速
    streamStartedAt: 0,
    // 是否正处于"一次给一大段"的加速播放状态
    burstMode: false
  };
  state.messages.push(userMsg, asstMsg);

  if (!state.convId && state.title === "新对话") {
    state.title = text.replace(/\s+/g, " ").slice(0, 30);
  }
  // 草稿发了第一条消息：先把列表里那条的标题换成刚输入的内容（不用等服务器），
  // 等保存成功再把它换成真正的对话条目（见 persistConversation）。
  if (state.draft) {
    state.draft.title = state.title;
    state.draft.updated = Date.now();
    renderSessions();
  }

  var box = $("#stream");
  var empty = box.querySelector(".empty-state");
  if (empty) box.removeChild(empty);
  // 刚发出的两条消息带动画（从下往上冒 + 渐显）；重新打开对话时不动
  box.appendChild(buildTurn(userMsg, true).root);
  var refs = buildTurn(asstMsg, true);
  box.appendChild(refs.root);

  input.value = "";
  autoGrow();
  state.busy = true;
  state.stopped = false;
  state.clientId = uid("c");
  state.abort = new AbortController();
  updateSend();
  scrollBottom(true);

  var history = state.messages.filter(function (m) {
    if (m === asstMsg) return false;
    if (m.role === "user") return Boolean(String(m.content || "").trim());
    return Boolean(m.content) || (m.toolCalls && m.toolCalls.length > 0);
  }).map(function (m) {
    // 上一轮的工具调用也带上，模型才知道它已经查过什么；服务端会把
    // assistant.tool_calls 和对应的 tool 结果一起重放，缺结果的调用它自己丢掉。
    var calls = m.role === "assistant" && Array.isArray(m.toolCalls)
      ? m.toolCalls.filter(function (c) { return c && c.name && (c.result || c.isError); })
      : [];
    return {
      role: m.role,
      content: m.content,
      toolCalls: calls,
      files: (m.files || []).filter(function (f) { return f && f.data; }).map(function (f) {
        return { name: f.name, type: f.type, kind: f.kind, size: f.size, data: f.data };
      })
    };
  });

  var payload = {
    messages: history,
    model: state.settings.model,
    effort: state.settings.effort || "",
    system: state.settings.system || "",
    temperature: Number(state.settings.temperature),
    maxTokens: Number(state.settings.maxTokens) || 0,
    useTools: (state.settings.mcp || []).length > 0,
    clientId: state.clientId
  };
  var started = Date.now();
  forageBegin(refs); // 开始计时：从按下发送到这一轮结束，显示在这条回复的底部

  streamChat(payload, function (evt) { handleEvent(evt, refs); }, state.abort.signal)
    .then(function () {
      if (!asstMsg.ms) asstMsg.ms = Date.now() - started;
      finish(refs);
    })
    .catch(function (err) {
      if (err && (err.name === "AbortError" || state.stopped)) {
        asstMsg.stopped = true;
        if (!asstMsg.ms) asstMsg.ms = Date.now() - started;
      } else {
        asstMsg.error = "请求出错：" + (err && err.message ? err.message : String(err));
        refs.err.textContent = asstMsg.error;
        refs.err.hidden = false;
      }
      finish(refs);
    });
}

function handleEvent(evt, refs) {
  var msg = refs.msg;
  switch (evt.type) {
    case "start":
      msg.model = evt.model || state.settings.model;
      msg.tools = Array.isArray(evt.tools) ? evt.tools : [];
      // 刚建这一轮时还可能没定模型，这里补上名字和图标
      updateLabel(refs);
      updateMeta(refs);
      break;
    case "reasoning":
      msg.reasoning += evt.text || "";
      if (state.settings.showReasoning !== false) {
        refs.think.hidden = false;
        refs.think.dataset.live = "1";
        if (!refs.think.dataset.user && !refs.think.open) {
          refs.think.dataset.program = "1";
          refs.think.open = true;
        }
        refs.thinkBody.appendChild(document.createTextNode(evt.text || ""));
        scrollBottom(false);
      }
      break;
    case "delta":
      // 先攒着，交给打字机队列按帧放，文字才是连续流出来的
      if (!msg.streamStartedAt) msg.streamStartedAt = (typeof performance !== "undefined" ? performance.now() : Date.now());
      msg.pending = (msg.pending || "") + (evt.text || "");
      pumpQueue.add(refs);
      pumpKick();
      break;
    case "tool":
      handleTool(evt, refs);
      break;
    case "usage":
      msg.usage = {
        prompt_tokens: Number(evt.prompt_tokens || 0),
        completion_tokens: Number(evt.completion_tokens || 0),
        total_tokens: Number(evt.total_tokens || 0)
      };
      updateMeta(refs);
      break;
    case "error":
      msg.error = evt.message || "未知错误";
      refs.err.textContent = msg.error;
      refs.err.hidden = false;
      break;
    case "done":
      msg.ms = Number(evt.ms || msg.ms || 0);
      if (evt.stopped) msg.stopped = true;
      break;
    default:
      break;
  }
}

function handleTool(evt, refs) {
  var msg = refs.msg;
  if (evt.phase === "note") {
    // 只是说明（比如「这次给了 9/48 个工具」），不是错误
    refs.note = refs.note || el("div", { class: "turn-note" });
    refs.note.textContent = String(evt.result || "");
    if (!refs.note.parentNode) refs.root.insertBefore(refs.note, refs.body);
    return;
  }
  if (evt.phase === "error") {
    var failed = { id: uid("tool"), name: evt.name || "MCP", args: "", result: evt.result || "连接失败", isError: true };
    msg.toolCalls.push(failed);
    var card0 = makeTalk(failed);
    card0.done();
    card0.root.open = true;
    refs.talks.appendChild(card0.root);
    updateMeta(refs);
    return;
  }
  if (evt.phase === "call") {
    var call = { id: evt.id || uid("call"), name: evt.name || "工具", args: evt.args || {}, result: "", isError: false };
    msg.toolCalls.push(call);
    var card = makeTalk(call);
    refs.cards[call.id] = card;
    refs.talks.appendChild(card.root);
    updateMeta(refs);
    scrollBottom(false);
    return;
  }
  if (evt.phase === "result") {
    var target = null;
    for (var i = msg.toolCalls.length - 1; i >= 0; i--) {
      if (evt.id && msg.toolCalls[i].id === evt.id) { target = msg.toolCalls[i]; break; }
    }
    if (!target) target = msg.toolCalls[msg.toolCalls.length - 1];
    if (!target) return;
    target.result = evt.result === undefined || evt.result === null ? "" : evt.result;
    target.isError = Boolean(evt.isError);
    var hit = refs.cards[target.id];
    if (!hit) {
      var keys = Object.keys(refs.cards);
      hit = refs.cards[keys[keys.length - 1]];
    }
    if (hit) hit.done();
    scrollBottom(false);
  }
}

/* ---------- 模型状态提示：觅食中 / 找到食物 / 没找到 ----------
   计时从用户按下发送算起，到这一轮结束为止。 */
var forage = { startAt: 0, tick: null, hideTimer: null };

// 2h32min22s / 32min22s / 22s
function fmtForageTime(ms) {
  var total = Math.max(0, Math.floor(ms / 1000));
  var h = Math.floor(total / 3600);
  var m = Math.floor((total % 3600) / 60);
  var s = total % 60;
  if (h > 0) return h + "h" + m + "min" + s + "s";
  if (m > 0) return m + "min" + s + "s";
  return s + "s";
}

// 把状态画到某一轮消息的底部。kind: busy | done | fail
function paintTurnForage(refs, kind, text, ms) {
  var box = refs && refs.forage;
  if (!box) return;
  box.hidden = false;
  box.classList.remove("busy", "done", "fail");
  if (kind) box.classList.add(kind);
  while (box.firstChild) box.removeChild(box.firstChild);
  box.appendChild(el("span", { class: "forage-dot" }));
  box.appendChild(el("span", { class: "forage-text", text: text }));
  if (ms != null) box.appendChild(el("span", { class: "forage-time", text: " · " + fmtForageTime(ms) }));
}

function forageClearTimers() {
  if (forage.tick) { clearInterval(forage.tick); forage.tick = null; }
}

// 开始：在这一轮消息底部显示"正在觅食ing…"，每秒走一次计时
function forageBegin(refs) {
  forageClearTimers();
  forage.startAt = Date.now();
  forage.refs = refs;
  paintTurnForage(refs, "busy", "Magpie正在觅食ing…", 0);
  forage.tick = setInterval(function () {
    var box = forage.refs && forage.refs.forage;
    if (!box) return;
    var time = box.querySelector(".forage-time");
    if (time) time.textContent = " · " + fmtForageTime(Date.now() - forage.startAt);
  }, 1000);
}

// 结束：ok=true 是找到了，false 是没找到（变红）。结果留在消息底部，跟着这条回复走。
function forageEnd(refs, ok, stopped) {
  var elapsed = forage.startAt ? Date.now() - forage.startAt : 0;
  forageClearTimers();
  var box = refs && refs.forage;
  if (!box) return;
  if (stopped) {
    box.hidden = true;
    return;
  }
  if (ok) {
    paintTurnForage(refs, "done", "Magpie找到了食物！", elapsed);
    if (refs.msg) refs.msg.forageMs = elapsed; // 重新打开这段对话时还能显示
  } else {
    paintTurnForage(refs, "fail", "Magpie没有找到食物", null);
  }
}

function finish(refs) {
  state.busy = false;
  state.abort = null;
  state.stopped = false;
  // 先把打字机队列里剩下的倒完，再收尾（否则最后一段可能没上屏）
  pumpFlush(refs);
  if (refs.caret && refs.caret.parentNode) refs.caret.parentNode.removeChild(refs.caret);
  refs.caret = null;
  // 保险：把这条消息里所有流式光标都清掉，别在正文末尾留个小色块
  if (refs.body) {
    refs.body.querySelectorAll(".streaming-caret").forEach(function (node) {
      if (node.parentNode) node.parentNode.removeChild(node);
    });
  }
  refs.think.dataset.live = "0";
  // 输出完就自动收起思考过程；用户自己展开过就尊重他的选择
  if (!refs.think.hidden && !refs.think.dataset.user && refs.think.open) {
    refs.think.dataset.program = "1";
    refs.think.open = false;
  }
  if (refs.dirty) { refs.dirty = false; renderMarkdown(refs.body, refs.msg.content); }
  // 流式结束时把"稳定块 + 尾巴"的结构换回一次完整渲染，保证格式正确
  else if (refs.body && refs.body.querySelector(".md-stable")) renderMarkdown(refs.body, refs.msg.content);
  state.liveRefs.delete(refs);
  updateMeta(refs);
  updateSend();
  scrollBottom(false);
  persistConversation();

  // 觅食状态收尾：出错变红，用户手动停止就收起，正常就是找到了
  var m = refs.msg || {};
  if (m.error) forageEnd(refs, false, false);
  else if (m.stopped) forageEnd(refs, false, true);
  else forageEnd(refs, true, false);
}

function stop() {
  if (!state.busy) return;
  state.stopped = true;
  var clientId = state.clientId;
  api("/api/chat/stop", { method: "POST", body: { clientId: clientId, id: clientId } }).catch(function () { /* 断开也会中止 */ });
  if (state.abort) {
    try { state.abort.abort(); } catch (e) { /* 已结束 */ }
  }
  toast("已停止生成", false);
}

/* ================= 事件绑定 ================= */

// 现在是不是停在一个"刚点新建、还没写任何东西"的空白对话里
function isBlankDraft() {
  return Boolean(state.draft) && !state.convId && !state.messages.length;
}

function newChat() {
  if (state.busy) { toast("正在生成，先停止再新建对话", true); return; }
  // 已经在一个空白的新对话里了：再点"新对话"就保持原样，别叠出第二个
  if (isBlankDraft()) { $("#input").focus(); return; }
  state.draft = { id: DRAFT_ID, title: "新对话", updated: Date.now() };
  state.convId = null;
  state.title = "新对话";
  state.messages = [];
  renderMessages();
  renderSessions();
  $("#input").focus();
}

// 离开草稿：如果它一个字都没写，就从列表里丢掉
function dropBlankDraft() {
  if (state.draft && !state.messages.length) {
    state.draft = null;
    return true;
  }
  return false;
}

function bindUI() {
  var input = $("#input");

  input.addEventListener("input", function () {
    autoGrow();
    updateSend();
  });

  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      send();
    }
  });

  $("#send").addEventListener("click", function () { if (state.busy) stop(); else send(); });
  $("#newSession").addEventListener("click", newChat);
  $("#sideToggle").addEventListener("click", function () {
    setSidebar($("#app").classList.contains("side-off"));
  });
  $("#dockToggle").addEventListener("click", function () { setSidebar(true); });
  bindAttachments();
  bindResizers();

  // 滚动条：滚时浮现，停手淡出；可拖动
  $("#stream").addEventListener("scroll", flashScrollBar, { passive: true });

  // 流式跟随：用户往上滑就停止跟随（不然每帧都被拽回底部，根本没法往回看）；
  // 滑回底部附近再自动恢复。
  $("#stream").addEventListener("scroll", function () {
    var box = $("#stream");
    state.follow = nearBottom(box);
  }, { passive: true });

  // 滚轮/触摸是最直接的"用户想往上翻"的意图，比 scroll 事件更早也更准
  $("#stream").addEventListener("wheel", function (e) {
    if (e.deltaY < 0) state.follow = false;
    else if (nearBottom($("#stream"))) state.follow = true;
  }, { passive: true });
  $("#stream").addEventListener("touchmove", function () {
    if (!nearBottom($("#stream"))) state.follow = false;
  }, { passive: true });
  bindScrollBarDrag();
  window.addEventListener("resize", paintScrollBar);

  $("#systemInput").addEventListener("input", function (e) {
    patchSettings({ system: e.target.value });
  });

  $("#temperature").addEventListener("input", function (e) {
    var v = Number(e.target.value);
    $("#tempValue").textContent = v.toFixed(2);
    patchSettings({ temperature: v });
  });

  // 会话区 / 输入框宽度：拖动时立刻生效，松手才写盘
  // 两个宽度滑条：开了"同步调整"就一起走
  $("#convWidth").addEventListener("input", function (e) {
    var v = Number(e.target.value);
    state.settings.convWidth = v;
    applyConvWidth(v);
    $("#convWidthValue").textContent = v >= 100 ? "铺满" : v + "%";
    if (state.settings.syncWidth) syncWidthTo("conv", v);
  });
  $("#convWidth").addEventListener("change", function (e) {
    var v = Number(e.target.value);
    patchSettings(state.settings.syncWidth ? { convWidth: v, composerWidth: v } : { convWidth: v });
  });
  $("#composerWidth").addEventListener("input", function (e) {
    var v = Number(e.target.value);
    state.settings.composerWidth = v;
    applyComposerWidth(v);
    $("#composerWidthValue").textContent = v + "%";
    if (state.settings.syncWidth) syncWidthTo("composer", v);
  });
  $("#composerWidth").addEventListener("change", function (e) {
    var v = Number(e.target.value);
    patchSettings(state.settings.syncWidth ? { convWidth: v, composerWidth: v } : { composerWidth: v });
  });

  // 开关：打开时先把两个宽度统一成较小的那个
  $("#syncWidth").addEventListener("click", function () {
    var on = !state.settings.syncWidth;
    state.settings.syncWidth = on;
    $("#syncWidth").setAttribute("aria-checked", on ? "true" : "false");
    if (on) {
      var v = Math.min(Number(state.settings.convWidth) || 72, Number(state.settings.composerWidth) || 70);
      state.settings.convWidth = v;
      state.settings.composerWidth = v;
      applyConvWidth(v);
      applyComposerWidth(v);
      $("#convWidth").value = String(v);
      $("#composerWidth").value = String(v);
      $("#convWidthValue").textContent = v >= 100 ? "铺满" : v + "%";
      $("#composerWidthValue").textContent = v + "%";
      patchSettings({ syncWidth: true, convWidth: v, composerWidth: v });
    } else {
      patchSettings({ syncWidth: false });
    }
  });

  $("#maxTokens").addEventListener("change", function (e) {
    var v = Math.max(0, Math.floor(Number(e.target.value) || 0));
    e.target.value = String(v);
    patchSettings({ maxTokens: v });
  });

  $("#showReasoning").addEventListener("click", function (e) {
    var on = e.currentTarget.getAttribute("aria-checked") !== "true";
    e.currentTarget.setAttribute("aria-checked", on ? "true" : "false");
    patchSettings({ showReasoning: on });
    $$(".think").forEach(function (node) {
      var body = node.querySelector(".think-body");
      node.hidden = !on || !body || !body.textContent;
    });
  });

  $("#checkTools").addEventListener("click", checkTools);

  bindPopTriggers();
  window.addEventListener("resize", autoGrow);
}

/* ================= 启动 ================= */

function boot() {
  bindUI();
  autoGrow();
  updateSend();
  renderMessages();

  api("/api/bootstrap").then(function (data) {
    state.boot = data || {};
    state.models = (data && data.models) || [];
    state.library = (data && data.library) || { instructions: [], skills: [], mcp: [] };
    applySettings(data && data.settings);
    // 侧栏上次是收起还是展开，进来就按那个来
    $("#app").classList.toggle("side-off", state.settings.sidebar === false);
    applyWidths();
    // 设置栏上次开着就还开着
    toggleSettings(state.settings.settingsOpen === true, false);
    renderPills();
    renderSettings();
    $("#version").textContent = "v" + (data.version || "0.1.0");
    if (data.error) toast("网关异常：" + data.error, true);
    else if (!state.models.length) toast("网关没有返回模型，检查 magpie 是否在运行", true);
    return loadConversations();
  }).catch(function (err) {
    // 界面先画出来了，只是数据还没到 —— 服务可能还在起（宿主刚被拉起、
    // 或者端口还被上一个进程占着）。这里自动等一会儿再试，别弹个红字就完事。
    bootRetry(err);
  });
}

// 服务还没就绪：把空态换成"正在连接"，每 600ms 重试一次，最多 20 次。
var bootTries = 0;
function bootRetry(err) {
  bootTries += 1;
  var empty = document.querySelector(".empty-state");
  if (empty) {
    var said = empty.querySelector("[data-boot]");
    if (!said) {
      said = document.createElement("div");
      said.setAttribute("data-boot", "1");
      said.style.cssText = "margin-top:10px;font-size:12px;color:var(--muted)";
      empty.appendChild(said);
    }
    said.textContent = bootTries < 3
      ? "正在连接对话服务…"
      : "正在连接对话服务…（第 " + bootTries + " 次）";
  }
  // 一直等到服务起来为止。插件宿主可能要排队加载很多插件（有人装了几十个），
  // 轮到我们可能是一两分钟后 —— 页面不能十几秒就放弃，那样用户只能对着错误页。
  // 90 秒后才开始给"看起来卡住了"的提示，但不停止重试。
  if (bootTries === 90) {
    toast("对话服务起得比较慢，还在等…（宿主可能正被其他插件占用）", false);
  }
  setTimeout(function () { boot(); }, 800);
}

// 先把界面点亮：空态不依赖任何接口，服务还没起来时也能看到侧栏和输入框，
// 而不是一片白等在那儿。数据随后由 boot() 填。
function paintSkeleton() {
  var box = $("#stream");
  if (box && !box.children.length) box.appendChild(emptyState());
  renderSessions();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", function () {
    paintSkeleton();
    boot();
  });
} else {
  paintSkeleton();
  boot();
}
