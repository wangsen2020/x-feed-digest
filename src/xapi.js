/*!
 * 复用 x.com 自己的 GraphQL 请求
 *
 * 两个关键决定，都是实测出来的：
 *
 * 1. 不硬编码 queryId / features。net-hook 把 X 真实发出的那一条存成模板，
 *    这里只替换 variables。X 前端发版后你正常刷一次 x.com 就自动更新。
 *    （实测印证：博主主页的 operation 已经从 UserTweets 换成了
 *      UserOriginalsTimeline，硬编码的写法早就挂了。）
 *
 * 2. 请求在 x.com 页面上下文里执行，不从 service worker 直接发。
 *    SW 发出的请求 Origin 是 chrome-extension://，X 大概率不认；
 *    丢进页面里执行则和 X 自己发的请求没有区别。实测 200，
 *    而且不需要 x-client-transaction-id。
 */

import { K, get } from './store.js';

/** 把 HTTP 结果归类成我们自己的错误类型 */
export function classify(status, json) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404 || status === 400) return 'stale';
  if (status === 429) return 'rate';
  if (status !== 200) return 'net';

  const errs = json && json.errors;
  if (Array.isArray(errs) && errs.length) {
    const msg = errs.map((e) => e && e.message).join(' ').toLowerCase();
    if (msg.includes('authoriz') || msg.includes('not logged')) return 'auth';
    return 'stale';
  }
  return 'ok';
}

export class XApiError extends Error {
  constructor(kind, status, detail) {
    super(kind + ' (HTTP ' + status + ')' + (detail ? ': ' + detail : ''));
    this.kind = kind;
    this.status = status;
  }
}

// ─────────────────────── 承载请求的 x.com 标签页 ───────────────────────

let ownTabId = null;   // 我们自己开的（用完要关），复用别人的则不动

async function findTab() {
  const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  const usable = tabs.find((t) => t.status === 'complete' && !t.discarded);
  return usable ? usable.id : null;
}

async function waitForLoad(tabId, timeoutMs) {
  // 先查一次当前状态：导航可能在我们挂上监听之前就已经完成了，
  // 那样只等事件会一直等到超时。
  try {
    const t = await chrome.tabs.get(tabId);
    if (t && t.status === 'complete') return;
  } catch (e) {}

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(fn); reject(new XApiError('net', 0, '标签页加载超时')); }, timeoutMs || 25000);
    const fn = (id, info) => {
      if (id !== tabId || info.status !== 'complete') return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(fn);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(fn);
  });
}

/** 开一个属于我们自己的标签页（最小化独立窗口，失败则退回后台标签页） */
async function openOwnTab(url) {
  if (ownTabId) {
    try { await chrome.tabs.get(ownTabId); return ownTabId; } catch (e) { ownTabId = null; }
  }
  let tabId = null;
  try {
    const win = await chrome.windows.create({ url, state: 'minimized', focused: false });
    tabId = win.tabs && win.tabs[0] && win.tabs[0].id;
  } catch (e) {
    // 某些环境下 state:'minimized' 建窗会失败，退回后台标签页
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
  }
  if (!tabId) throw new XApiError('net', 0, '无法打开 x.com 标签页');
  await waitForLoad(tabId);
  ownTabId = tabId;
  return tabId;
}

/**
 * 拿到一个可用的 x.com 标签页。
 * 优先复用你已经开着的——那样完全没有痕迹。一个都没有才自己开。
 * 这里不需要页面渲染（只发 fetch，不滚动不读 DOM），
 * 所以后台窗口被挂起渲染完全不影响。
 */
async function ensureTab() {
  const existing = await findTab();
  if (existing) return existing;
  return openOwnTab('https://x.com/home');
}

/**
 * 开一个我们自己的标签页并停在指定页面。
 * Grok 要用：必须是我们自己的页面，不能劫持你正在看的标签页。
 */
export async function openScratchTab(url) {
  const tabId = await openOwnTab(url);
  await chrome.tabs.update(tabId, { url });
  await waitForLoad(tabId);
  return tabId;
}

/** 收工时把我们自己开的那个关掉；复用别人的不碰。 */
export async function releaseTab() {
  if (!ownTabId) return;
  const id = ownTabId;
  ownTabId = null;
  try { await chrome.tabs.remove(id); } catch (e) {}
}

/** 注入到页面里执行的函数。必须自包含——不能引用外部作用域。 */
function pageFetch(url, headers) {
  return fetch(url, { method: 'GET', credentials: 'include', headers })
    .then((r) => r.text().then((t) => {
      let json = null;
      try { json = JSON.parse(t); } catch (e) {}
      return { status: r.status, json };
    }))
    .catch((e) => ({ status: 0, json: null, err: String(e && e.message || e) }));
}

async function runInPage(url, headers) {
  const tabId = await ensureTab();
  let res;
  try {
    res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: pageFetch,
      args: [url, headers],
    });
  } catch (e) {
    throw new XApiError('net', 0, '注入失败：' + (e && e.message));
  }
  const r = res && res[0] && res[0].result;
  if (!r) throw new XApiError('net', 0, '页面未返回结果');
  if (r.err) throw new XApiError('net', 0, r.err);
  return r;
}

/**
 * 我自己的 userId。
 * 直接读 twid cookie（值形如 u%3D1234567890），不依赖任何 GraphQL 模板——
 * 之前从 Following 模板的 variables 里蹭 userId，导致「还没开过关注页」就卡死，
 * 属于没必要的依赖。
 */
export async function myUserId() {
  try {
    const c = await chrome.cookies.get({ url: 'https://x.com', name: 'twid' });
    if (c && c.value) {
      const m = decodeURIComponent(c.value).match(/u=(\d+)/);
      if (m) return m[1];
    }
  } catch (e) {}
  return '';
}

/**
 * 我自己的 handle：从页面导航栏的「个人资料」链接读。
 * tabId 必须显式传——之前这里用 ensureTab()，会复用你已经开着的任意 x.com
 * 标签页，读的根本不是 bootstrap 刚开的那个，读不到就误报「凭证失效」。
 */
export async function myHandle(tabId) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: () => {
        const a = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
        return a ? (a.getAttribute('href') || '').replace(/^\//, '') : '';
      },
    });
    return (res && res[0] && res[0].result) || '';
  } catch (e) { return ''; }
}

/** 当前标签页停在哪个路径上（跳转后用来反推 handle） */
async function pathOf(tabId) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN', func: () => location.pathname,
    });
    return (res && res[0] && res[0].result) || '';
  } catch (e) { return ''; }
}

/** 轮询等某个模板出现，比固定 sleep 可靠——请求什么时候发完是不确定的 */
async function waitForTemplate(names, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 12000);
  while (Date.now() < deadline) {
    const all = await get(K.TEMPLATES, {});
    if (names.some((n) => all[n] && all[n].queryId)) return true;
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

/**
 * 自动补齐缺失的模板：自己开一个后台标签页，依次走一遍会触发对应请求的页面，
 * net-hook 就把模板顺手捕获了。全程不碰你正在用的标签页。
 *
 * 这是「模板没捕到」的自愈路径——不该要求你手动去点某个页面。
 */
export async function bootstrap(need) {
  const want = need || ['UserByScreenName', 'UserOriginalsTimeline', 'Following'];
  const tabId = await openOwnTab('https://x.com/home');
  await waitForLoad(tabId);

  // handle 优先从刚开的这个页面读；读不到就用 twid 里的 userId 跳一次
  // /i/user/<id>（X 会 302 到 /<handle>），再从地址栏反推。
  let handle = await myHandle(tabId);
  if (!handle) {
    const uid = await myUserId();
    if (uid) {
      await chrome.tabs.update(tabId, { url: 'https://x.com/i/user/' + uid });
      await waitForLoad(tabId);
      await new Promise((r) => setTimeout(r, 2500));
      handle = (await pathOf(tabId)).replace(/^\//, '').split('/')[0];
    }
  }
  if (!handle) throw new XApiError('auth', 0, '读不到你的账号信息，请确认 x.com 已登录');

  const steps = [];
  const plan = [
    { url: 'https://x.com/' + handle, ops: ['UserByScreenName', 'UserOriginalsTimeline', 'UserTweets'] },
    { url: 'https://x.com/' + handle + '/following', ops: ['Following'] },
  ];

  for (const step of plan) {
    if (step.ops.every((o) => !want.includes(o))) continue;
    await chrome.tabs.update(tabId, { url: step.url });
    await waitForLoad(tabId);
    // 页面 load 完 ≠ 数据请求发完。轮询等模板落盘，比固定 sleep 可靠得多。
    const ok = await waitForTemplate(step.ops, 15000);
    steps.push({ url: step.url, ok });
  }

  const all = await get(K.TEMPLATES, {});
  const captured = want.filter((n) => all[n] && all[n].queryId);
  const missing = want.filter((n) => !all[n] || !all[n].queryId);
  return { handle, captured, missing, steps };
}


// ─────────────────────── operation 调用 ───────────────────────

async function template(names) {
  const all = await get(K.TEMPLATES, {});
  for (const n of names) if (all[n] && all[n].queryId) return [n, all[n]];
  // 注意这里是 setup 不是 stale：模板从来没捕到过，和「X 发版导致模板过期」
  // 是两回事，提示文案和处理方式都不一样（前者能自动补，后者要等你刷 x.com）。
  throw new XApiError('setup', 0, '尚未捕获 ' + names.join(' / ') + ' 的请求模板');
}

/**
 * @param {string[]} names  候选 operation 名（按优先级），第一个捕到的胜出
 * @param {object}   vars   覆盖进 variables 的字段
 */
export async function callOp(names, vars) {
  const [op, t] = await template(Array.isArray(names) ? names : [names]);

  // 以捕获到的 variables 为底板，只覆盖我们关心的字段。
  // X 以后新增的必填字段会被原样继承，不用跟着改代码。
  let base = {};
  try { base = t.variables ? JSON.parse(t.variables) : {}; } catch (e) {}
  const variables = { ...base, ...vars, includePromotedContent: false };

  const qs = new URLSearchParams({ variables: JSON.stringify(variables) });
  if (t.features) qs.set('features', t.features);
  if (t.fieldToggles) qs.set('fieldToggles', t.fieldToggles);

  const url = (t.origin || 'https://x.com') + '/i/api/graphql/' + t.queryId + '/' + op + '?' + qs;

  const headers = { ...(t.headers || {}), 'content-type': 'application/json' };
  // 实测不需要 transaction-id，带着反而可能因为过期被拒
  delete headers['x-client-transaction-id'];
  // ct0 会轮换，每次从当前 cookie 重新取，保证和 x-csrf-token 一致
  try {
    const c = await chrome.cookies.get({ url: 'https://x.com', name: 'ct0' });
    if (c && c.value) headers['x-csrf-token'] = c.value;
  } catch (e) {}

  const { status, json } = await runInPage(url, headers);
  const kind = classify(status, json);
  if (kind !== 'ok') {
    const detail = json && json.errors && json.errors[0] && json.errors[0].message;
    throw new XApiError(kind, status, detail);
  }
  return json;
}

// ─────────────────────── 具体调用 ───────────────────────

export async function resolveUserId(handle) {
  const json = await callOp(['UserByScreenName'], { screen_name: handle });
  const { readUserId } = await import('./parse.js');
  const id = readUserId(json);
  if (!id) throw new XApiError('stale', 200, '未能从响应里解析出 @' + handle + ' 的 userId');
  return id;
}

/** 拉某个用户的最近推文。operation 名 X 改过，按优先级挨个试。 */
export function fetchUserTweets(userId, count) {
  return callOp(['UserOriginalsTimeline', 'UserTweets', 'UserTweetsAndReplies'], { userId, count: count || 40 });
}

/** 拉我关注的人（分页游标） */
export function fetchFollowing(userId, cursor, count) {
  const vars = { userId, count: count || 100 };
  if (cursor) vars.cursor = cursor;
  return callOp(['Following'], vars);
}
