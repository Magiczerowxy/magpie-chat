// 带路页：把它自己（也就是 magpie 页面那个框架）导航到插件的服务。
//
// 这里必须"直接跳"，不能先探测：
//   页面的 CSP 是 connect-src 'none'，fetch/XHR/WebSocket 全被禁止 ——
//   连 no-cors 的请求都会被直接拒绝。所以「先探一下服务在不在」这条路走不通，
//   alive() 永远返回 false，页面会永远停在等待页。
//   magpie 文档也明说了：这个页面唯一能做的联网动作就是把自己跳转到别处。
//
// 端口用插件选项里的 port（默认 3477），服务端（index.mjs）读的是同一个值。
//
// 跳到哪：magpie 把页面给浏览器时（`magpie web`，可能在另一台电脑上打开），
// 127.0.0.1 是看页面那台电脑自己，不是跑服务的机器。这时 bridge 会给出
// magpie.service：magpie web 在它自己的地址上替本服务转发的路径（package.json
// 的 magpie.page.service 声明了它）。有就跳那里；没有（桌面窗口，或旧版
// magpie）就照旧跳 127.0.0.1。
//
// 顺手把窗口的主题和设计令牌一起带上（magpie 的 bridge 已经把它们算好了），
// 这样对话页的配色和字体跟窗口完全一致，连用户的自定义主题也算在内。
(async () => {
  const DEFAULT_PORT = 3477;
  let port = DEFAULT_PORT;
  let theme = "";
  let tokens = null;
  let service = "";

  try {
    const t = await window.magpie?.ready;           // { dark, lang, tokens }
    if (t) {
      if (typeof t.dark === "boolean") theme = t.dark ? "dark" : "light";
      if (t.tokens && typeof t.tokens === "object") tokens = t.tokens;
    }
  } catch { /* 没有 bridge 就退回默认主题 */ }
  try {
    const s = window.magpie?.service;
    if (typeof s === "string" && /^https?:\/\//.test(s)) service = s;
  } catch { /* 旧版 magpie 没有 service */ }

  try {
    const o = await window.magpie?.options?.get?.();
    if (o && Number.isFinite(Number(o.port)) && Number(o.port) > 0) port = Number(o.port);
  } catch { /* 没有 options 就用默认端口 */ }

  // 字体不在这里传。
  //
  // 试过从 magpie 页面的 CSS 变量里读 --ui-font 再带过去，但时机靠不住：
  // magpie 是设置加载完之后才把 --ui-font 写到 :root 上的，这里 await 完
  // magpie.ready 立刻读，经常读到空。而且页面 CSP 是 connect-src 'none'，
  // 读不到也没法重试。现在改成服务端直接读 magpie 的 settings.json，
  // 由 /api/fonts.css 提供给对话页 —— 那边什么时候读都准。

  const q = new URLSearchParams();
  if (theme) q.set("theme", theme);
  if (true) {
    // 只留非空的令牌，压成一个短串；令牌本身就是 magpie 自己的 CSS 变量值。
    const slim = {};
    for (const [k, v] of Object.entries(tokens || {})) {
      const s = String(v ?? "").trim();
      if (s) slim[k] = s;
    }
    if (Object.keys(slim).length) {
      try { q.set("tokens", btoa(unescape(encodeURIComponent(JSON.stringify(slim))))); } catch { /* 编码不了就只带主题 */ }
    }
  }

  // WebKit 在目标不可达时不会报错：location.replace 失败了也当没事，
  // 页面就永远停在「正在连接到本地对话服务…」。5 秒后如果这份文档还活着，
  // 说明跳转根本没走成，换成能操作的提示。
  function armTimeout(p) {
    setTimeout(function () {
      var said = document.getElementById("said");
      if (!said) return;
      said.textContent = "本地对话服务没有在运行（127.0.0.1:" + p + "）";
      if (document.getElementById("boot-retry")) return;
      var btn = document.createElement("button");
      btn.id = "boot-retry";
      btn.type = "button";
      btn.textContent = "重试";
      btn.style.cssText = "margin-left:10px;padding:2px 12px;font:inherit;cursor:pointer;";
      btn.addEventListener("click", function () { location.reload(); });
      said.parentNode.appendChild(btn);
    }, 5000);
  }
  // magpie 给了 service 就走它：这是 magpie web 在自己地址上的转发，远程也能用。
  if (service) {
    armTimeout(port);
    location.replace(service + "?" + q.toString());
    return;
  }

  const target = "http://127.0.0.1:" + port + "/?" + q.toString();

  // 服务只听本机的 127.0.0.1，跳过去的是「打开这个页面的浏览器」所在的机器。
  // magpie web 部署在服务器上、从别的电脑打开时，那台电脑的 127.0.0.1 上没有服务，
  // 直接跳只会得到「127.0.0.1 拒绝连接」（Discord DM: AIGCFREE，magpie web + nginx）。
  // 旧版 magpie 不给 service 时，先说明原因，给出 SSH 端口转发的做法，转好了再点「继续」。
  if (!isLoopback(location.hostname)) {
    showRemote(port, target);
    return;
  }
  armTimeout(port);
  location.replace(target);
})();

function isLoopback(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  return h === "" || h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\./.test(h);
}

function showRemote(port, target) {
  const said = document.getElementById("said");
  if (!said) return;
  const host = location.hostname.replace(/^\[|\]$/g, "");
  said.textContent = "";
  const p = (text) => {
    const el = document.createElement("p");
    el.textContent = text;
    said.appendChild(el);
    return el;
  };
  p("对话页的服务只在运行 magpie 的那台机器上监听 127.0.0.1:" + port + "，从这台电脑的浏览器连不到它。");
  p("在这台电脑上开一个 SSH 端口转发，然后点「继续」：");
  const code = p("ssh -N -L " + port + ":127.0.0.1:" + port + " <用户名>@" + host);
  code.style.fontFamily = "ui-monospace, Menlo, Consolas, monospace";
  code.style.userSelect = "all";
  const go = document.createElement("button");
  go.type = "button";
  go.textContent = "继续";
  go.addEventListener("click", () => location.replace(target));
  said.appendChild(go);
}
