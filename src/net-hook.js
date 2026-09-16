/*!
 * X Feed Digest — 网络层嗅探器（MAIN world / document_start）
 *
 * 干两件事：
 *
 * 1. 采集「请求模板」。X 自己发出的 GraphQL 请求里，queryId 在路径上、
 *    features / fieldToggles 在 query string 里，三者都会随前端发版变化。
 *    与其把它们硬编码进扩展（每次改版就失效），不如把 X 自己发的那一条
 *    原样存下来，之后复用时只替换 variables。这样前端发版后只要你正常
 *    刷一次 x.com，模板就自动更新了。
 *
 * 2. 被动囤积响应。就算主动复用请求被风控挡掉，只要你平时刷 X，
 *    UserTweets / HomeLatestTimeline 的响应也会被顺手存下来，
 *    汇总时还有数据可用。这是主动抓取失败时的兜底。
 */
(function () {
  'use strict';
  if (window.__XFD_HOOKED) return;
  window.__XFD_HOOKED = true;

  // X 改过博主主页时间线的 operation 名（UserTweets → UserOriginalsTimeline），
  // 所以这里把新旧都收下，xapi 侧按优先级挨个试。
  const OPS = [
    'UserByScreenName',
    'UserOriginalsTimeline',
    'UserTweets',
    'UserTweetsAndReplies',
    'HomeLatestTimeline',
    'HomeTimeline',
    'Following',
  ];
  const RE = new RegExp('/graphql/([^/?]+)/(' + OPS.join('|') + ')');

  const post = (payload) => {
    try { window.postMessage(Object.assign({ __xfd: 1 }, payload), '*'); } catch (e) {}
  };

  // 只留我们复用时真正要带上的头。其余（cookie 由浏览器自动带、
  // content-type 我们自己设）一律不碰，免得把无关信息存进 storage。
  const WANTED = [
    'authorization',
    'x-csrf-token',
    'x-twitter-auth-type',
    'x-twitter-active-user',
    'x-twitter-client-language',
    'x-client-transaction-id',
  ];

  const pickHeaders = (h) => {
    const out = {};
    if (!h) return out;
    try {
      if (typeof h.forEach === 'function' && !Array.isArray(h)) {
        // Headers 实例
        h.forEach((v, k) => { if (WANTED.includes(String(k).toLowerCase())) out[String(k).toLowerCase()] = v; });
        return out;
      }
      for (const k of Object.keys(h)) {
        const lk = String(k).toLowerCase();
        if (WANTED.includes(lk)) out[lk] = h[k];
      }
    } catch (e) {}
    return out;
  };

  const capture = (url, headers, json) => {
    const m = RE.exec(String(url));
    if (!m) return;
    const [, queryId, op] = m;
    let features = null, fieldToggles = null, variables = null;
    try {
      const qs = new URL(String(url), location.origin).searchParams;
      features = qs.get('features');
      fieldToggles = qs.get('fieldToggles');
      // variables 也存下来当底板：X 新增的必填字段会被原样继承，
      // 复用时我们只覆盖 userId / screen_name / count 这几个自己关心的。
      variables = qs.get('variables');
    } catch (e) {}

    post({
      kind: 'template',
      op,
      queryId,
      features,
      fieldToggles,
      variables,
      headers: pickHeaders(headers),
      origin: new URL(String(url), location.origin).origin,
    });

    if (json) post({ kind: 'payload', op, url: String(url), json, t: Date.now() });
  };

  // ---- Grok 流式回答 ----
  // 直接伪造 add_response.json 请求打不通（实测三个路径全 404，缺 x-client-transaction-id，
  // 那个值是 X 前端每条请求现算的，伪造不了）。所以走法是：驱动 Grok 自己的输入框
  // 让 X 的代码把请求发出去，我们只在这里把响应流截下来——答案不用读 DOM，
  // 后台窗口渲染被挂起也不影响。
  const GROK_RE = /\/2\/grok\/add_response\.json/;

  const emitGrok = (text) => {
    // 实测的流格式（ndjson，每行一个对象）：
    //   {"result":{"message":"Thinking about your request","isThinking":true,"messageTag":"header"}}
    //   {"result":{"messageTag":"response_start",...}}
    //   {"result":{"message":"验证","messageTag":"final"}}
    //   {"result":{"message":"中","messageTag":"final"}}
    // 答案 = messageTag 为 final 的 message 拼接。
    // 不能无差别拼所有 message——那样会把「Thinking about your request」也拼进去。
    const finals = [];
    const others = [];
    for (const line of String(text).split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line).result;
        if (!r || typeof r.message !== 'string') continue;
        if (r.messageTag === 'final') finals.push(r.message);
        else if (!r.isThinking && r.messageTag !== 'header') others.push(r.message);
      } catch (e) {}
    }
    // final 是正常路径；X 以后要是改了 tag 名，退回「排除思考提示的全部 message」
    const msg = finals.length ? finals.join('') : others.join('');
    post({ kind: 'grok', text: msg, raw: msg ? '' : String(text).slice(0, 400) });
  };


  // ---- fetch ----
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (...args) {
      let url = '', headers = null;
      try {
        const a = args[0];
        // 三种形态都要认：字符串、Request（有 .url）、URL 对象（只有 .href）
        if (typeof a === 'string') { url = a; headers = args[1] && args[1].headers; }
        else if (a && a.url) { url = a.url; headers = a.headers || (args[1] && args[1].headers); }
        else if (a && a.href) { url = a.href; headers = args[1] && args[1].headers; }
      } catch (e) {}

      const p = origFetch.apply(this, args);

      if (GROK_RE.test(url)) {
        p.then((resp) => {
          try { resp.clone().text().then(emitGrok).catch(() => {}); } catch (e) {}
        }).catch(() => {});
      }

      if (RE.test(url)) {
        // 模板先存——哪怕这条请求本身失败了，头和 queryId 也是有效的。
        try { capture(url, headers, null); } catch (e) {}
        p.then((resp) => {
          try {
            resp.clone().json().then((j) => capture(url, headers, j)).catch(() => {});
          } catch (e) {}
        }).catch(() => {});
      }
      return p;
    };
  }

  // ---- XMLHttpRequest ----
  const XP = XMLHttpRequest.prototype;
  const origOpen = XP.open;
  const origSend = XP.send;
  const origSetHeader = XP.setRequestHeader;

  XP.open = function (method, url, ...rest) {
    try { this.__xfdUrl = String(url); this.__xfdHeaders = {}; } catch (e) {}
    return origOpen.call(this, method, url, ...rest);
  };
  XP.setRequestHeader = function (k, v) {
    try { if (this.__xfdHeaders) this.__xfdHeaders[String(k).toLowerCase()] = v; } catch (e) {}
    return origSetHeader.call(this, k, v);
  };
  XP.send = function (...args) {
    try {
      if (RE.test(this.__xfdUrl || '')) {
        capture(this.__xfdUrl, this.__xfdHeaders, null);
        this.addEventListener('load', () => {
          try { capture(this.__xfdUrl, this.__xfdHeaders, JSON.parse(this.responseText)); } catch (e) {}
        });
      }
    } catch (e) {}
    return origSend.apply(this, args);
  };
})();
