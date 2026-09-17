/*! service worker：定时调度、分档抓取、失败提醒 */

import { K, get, set, getSettings } from './store.js';
import { collectTweets, collectUsers, readCursor } from './parse.js';
import * as x from './xapi.js';
import { isDue, countFor, lookbackSince, updateCadence, backoff, TIERS } from './cadence.js';
import * as grok from './grok.js';

const ALARM_DAILY = 'xfd-daily';
const NOTIF_ATTENTION = 'xfd-attention';
const NOTIF_RECOVERED = 'xfd-recovered';
const ICON = 'icons/icon128.png';

// ────────────────────────────── 健康状态与提醒 ──────────────────────────────

const REASON = {
  setup: { title: '还没装好', body: '需要先在 x.com 上捕获一次接口调用参数。点下面的按钮，扩展会自己开一个后台页面完成，不用你动手。' },
  auth:  { title: '凭证已失效', body: '登录态或 CSRF token 变了，抓取被拒。点这里打开 x.com，正常浏览一下即可自动重新捕获。' },
  stale: { title: '接口版本已变更', body: 'X 前端发版，接口参数对不上了。点这里打开 x.com，刷一下首页和任意博主主页即可自动更新模板。' },
  rate:  { title: '连续被限流', body: '请求被 X 限流多次。已自动放慢节奏，可稍后手动重试一次。' },
  net:   { title: '网络异常', body: '连续多次请求失败，可能是网络或 X 服务端问题。' },
};

async function setBadge(on) {
  try {
    await chrome.action.setBadgeText({ text: on ? '!' : '' });
    if (on) await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  } catch (e) {}
}

/** 需要你介入的失败：常驻弹窗 + 角标。点通知或按钮直接打开 x.com。 */
async function raiseAttention(kind, detail) {
  const r = REASON[kind] || REASON.net;
  await set(K.HEALTH, { state: kind, reason: detail || '', at: Date.now(), needsAttention: true });
  await setBadge(true);

  try { await chrome.notifications.clear(NOTIF_ATTENTION); } catch (e) {}
  chrome.notifications.create(NOTIF_ATTENTION, {
    type: 'basic',
    iconUrl: ICON,
    title: 'X Feed Digest — ' + r.title,
    message: r.body + (detail ? '\n\n(' + detail + ')' : ''),
    buttons: [{ title: kind === 'setup' ? '自动捕获一次' : '打开 x.com 重新捕获' }, { title: '查看详情' }],
    requireInteraction: true,   // 不自动消失，免得你没看见
    priority: 2,
  });
}

async function clearAttention() {
  const h = await get(K.HEALTH, {});
  await set(K.HEALTH, { state: 'ok', at: Date.now(), needsAttention: false, failStreak: 0 });
  await setBadge(false);
  try { await chrome.notifications.clear(NOTIF_ATTENTION); } catch (e) {}

  if (h && h.needsAttention) {
    chrome.notifications.create(NOTIF_RECOVERED, {
      type: 'basic', iconUrl: ICON,
      title: 'X Feed Digest — 已恢复',
      message: '请求模板和凭证已重新捕获，定时汇总恢复正常。',
      priority: 1,
    });
  }
}

/** 限流 / 网络类错误不立刻打扰，连续 3 次才提醒。 */
async function softFailure(kind, detail) {
  const h = await get(K.HEALTH, {});
  const streak = (h.failStreak || 0) + 1;
  await set(K.HEALTH, { ...h, state: kind, reason: detail || '', at: Date.now(), failStreak: streak });
  if (streak >= 3) await raiseAttention(kind, detail);
}

const openX = () => chrome.tabs.create({ url: 'https://x.com/home' });

chrome.notifications.onClicked.addListener((id) => {
  if (id === NOTIF_ATTENTION) { openX(); chrome.notifications.clear(id); return; }
  if (id.startsWith('xfd-done-')) { chrome.runtime.openOptionsPage(); chrome.notifications.clear(id); }
});

chrome.notifications.onButtonClicked.addListener(async (id, idx) => {
  if (id !== NOTIF_ATTENTION) return;
  chrome.notifications.clear(id);
  if (idx !== 0) { chrome.runtime.openOptionsPage(); return; }
  const h = await get(K.HEALTH, {});
  // setup 能自愈，直接跑一遍；auth / stale 得你本人去刷 x.com
  if (h.state === 'setup') { await doBootstrap(); } else { openX(); }
});

/*
 * 「还没捕获模板」不该是一个挂在界面上等你点的报错——它能自愈。
 * 面板和 popup 一打开就调这个，缺了就自己补上。
 *
 * 两道闸防止反复开后台窗口：
 *   - 有任务在跑就跳过（互斥锁那套）
 *   - 10 分钟内只自动尝试一次；失败了也不立刻重来
 * 真的补不上（比如没登录）才升级成需要你处理的报错。
 */
let lastAutoBootstrap = 0;
const AUTO_BOOTSTRAP_COOLDOWN = 10 * 60 * 1000;

async function ensureReady(opts) {
  const force = !!(opts && opts.force);
  const tpl = await get(K.TEMPLATES, {});
  const ready = (tpl.UserOriginalsTimeline || tpl.UserTweets) && tpl.UserByScreenName;
  if (ready && !force) return { ok: true, already: true };

  if (job) return { ok: false, busy: true, error: '有任务在跑，稍后自动重试' };

  const h = await get(K.HEALTH, {});
  // auth / stale 要你本人去刷 x.com，自动开窗也解决不了，别白折腾
  if (h.needsAttention && (h.state === 'auth' || h.state === 'stale') && !force) {
    return { ok: false, error: h.state };
  }

  if (!force && Date.now() - lastAutoBootstrap < AUTO_BOOTSTRAP_COOLDOWN) {
    return { ok: false, cooling: true };
  }
  lastAutoBootstrap = Date.now();
  return withJob('bootstrap', doBootstrap);
}

/** 自动补齐模板：开后台页走一遍触发请求的页面。失败了才需要你介入。 */
async function doBootstrap() {
  try {
    report('正在打开后台页面捕获接口参数…');
    const r = await x.bootstrap();

    if (r.missing && r.missing.length) {
      // 别静悄悄地关窗了事——明确说清楚哪个没抓到
      await raiseAttention('setup', '这些接口参数没抓到：' + r.missing.join('、'));
      return { ok: false, error: '未捕获：' + r.missing.join('、'), ...r };
    }

    await clearAttention();
    return { ok: true, ...r };
  } catch (e) {
    await raiseAttention(e.kind === 'auth' ? 'auth' : 'setup', e.message);
    return { ok: false, error: e.message };
  } finally {
    await x.releaseTab();
  }
}


// ────────────────────────────── 任务互斥与进度 ──────────────────────────────

/*
 * 同一时刻只允许跑一个任务。
 * 这不只是为了 UI 好看：抓取和导入共用同一个 x.com 标签页（xapi.js 的 ownTabId），
 * 并发时先结束的那个会 releaseTab() 把另一个正在用的标签页关掉，
 * 后者就会以「注入失败」告终。锁必须在后台，UI 拦截只是顺带。
 */
let job = null;        // { name, label, startedAt, progress, cancelling }
let cancelFlag = false;  // 取消是协作式的：任务在每个博主之间检查一次

/** 任务内部的检查点。返回 true 表示该收工了。 */
function cancelled() { return cancelFlag; }

const JOB_LABEL = {
  digest: '汇总抓取',
  analyze: 'Grok 分析',
  import: '导入关注列表',
  bootstrap: '捕获接口参数',
};

function broadcastJob() {
  try { chrome.runtime.sendMessage({ cmd: 'jobState', job }, () => void chrome.runtime.lastError); } catch (e) {}
}

/** 供任务内部回报进度，UI 上直接显示这句话 */
function report(text) {
  if (!job) return;
  job.progress = text;
  broadcastJob();
}

async function withJob(name, fn) {
  if (job) {
    return { ok: false, busy: true, error: '正在' + (JOB_LABEL[job.name] || job.name) + '，等它跑完再操作' };
  }
  job = { name, label: JOB_LABEL[name] || name, startedAt: Date.now(), progress: '', cancelling: false };
  cancelFlag = false;
  broadcastJob();
  try {
    return await fn();
  } finally {
    job = null;
    cancelFlag = false;
    broadcastJob();
  }
}

/**
 * 请求取消。不硬中断在途请求——那样容易留下半个写坏的状态；
 * 改成打个标记，任务在每个博主之间的检查点自己退出，
 * 已经抓到的东西照常保存。最坏等一个博主的时间（几秒）。
 */
function requestCancel() {
  if (!job) return { ok: false, error: '当前没有任务在跑' };
  cancelFlag = true;
  job.cancelling = true;
  grok.abort('已取消 Grok 分析');   // 正等着 Grok 流返回的话，立刻放弃
  job.progress = '正在收尾，已抓到的内容会保留…';
  broadcastJob();
  return { ok: true };
}

// ────────────────────────────── 嗅探结果入库 ──────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.cmd) return;

  if (msg.cmd === 'template') {
    (async () => {
      const all = await get(K.TEMPLATES, {});
      all[msg.op] = {
        queryId: msg.queryId,
        features: msg.features,
        fieldToggles: msg.fieldToggles,
        variables: msg.variables,
        headers: msg.headers || {},
        origin: msg.origin || 'https://x.com',
        at: Date.now(),
      };
      await set(K.TEMPLATES, all);
      const h = await get(K.HEALTH, {});
      if (h && h.needsAttention && h.state !== 'rate' && h.state !== 'net') await clearAttention();
    })();
    return;
  }

  if (msg.cmd === 'grokAnswer') {
    grok.deliverAnswer(msg.text, msg.raw);
    return;
  }

  if (msg.cmd === 'payload') {
    // 被动囤积：你平时刷 X 时顺手存下来，作为主动抓取失败时的兜底数据
    (async () => {
      const pool = await get(K.POOL, {});
      const cutoff = Date.now() - 3 * 24 * 3600 * 1000;
      for (const t of collectTweets(msg.json)) {
        if (t.createdAt && t.createdAt > cutoff) pool[t.id] = t;
      }
      for (const id of Object.keys(pool)) {
        if (!pool[id].createdAt || pool[id].createdAt < cutoff) delete pool[id];
      }
      await set(K.POOL, pool);
    })();
    return;
  }

  if (msg.cmd === 'jobStatus') { sendResponse({ job }); return true; }

  if (msg.cmd === 'cancelJob') { sendResponse(requestCancel()); return true; }

  if (msg.cmd === 'runNow') {
    // 手动跑也算「这一轮跑过了」，否则下次启动会以为漏了又补一遍
    withJob('digest', async () => {
      await set(K.LASTRUN, Date.now());
      logRun('manual', '手动汇总');
      const r = await runDigest({ manual: true });
      logRun(...digestLine(r));
      return r;
    })
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  if (msg.cmd === 'importFollowing') {
    withJob('import', importFollowing)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  if (msg.cmd === 'resetBatch') {
    // 只丢批次（队列 + 帖子），结论历史不动
    chrome.storage.local.remove(K.BATCH).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.cmd === 'analyze') {
    withJob('analyze', analyzeLatest)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  if (msg.cmd === 'bootstrap') {
    // 手动点的按钮：无视节流，强制跑一次
    ensureReady({ force: true }).then(sendResponse);
    return true;
  }

  if (msg.cmd === 'ensureReady') {
    ensureReady().then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e && e.message) }));
    return true;
  }

  if (msg.cmd === 'reschedule') {
    // 保存设置触发的排期不补跑，否则改个无关选项就顺手跑一轮
    schedule().then(async () => {
      const al = await chrome.alarms.get(ALARM_DAILY);
      sendResponse({ ok: true, next: al ? al.scheduledTime : 0 });
    });
    return true;
  }

  if (msg.cmd === 'runLog') {
    Promise.all([get(K.RUNLOG, []), chrome.alarms.get(ALARM_DAILY), get(K.LASTRUN, 0)])
      .then(([log, al, last]) => sendResponse({ log, next: al ? al.scheduledTime : 0, last }));
    return true;
  }

  if (msg.cmd === 'clearRunLog') {
    set(K.RUNLOG, []).then(() => sendResponse({ ok: true }));
    return true;
  }
});

// ────────────────────────────── 从关注列表导入 ──────────────────────────────

async function importFollowing() {
  try {
    // userId 从 twid cookie 读，不依赖任何模板
    const myId = await x.myUserId();
    if (!myId) throw new x.XApiError('auth', 0, '读不到登录信息，请确认 x.com 已登录');

    const list = await get(K.AUTHORS, []);
    const known = new Set(list.map((a) => a.handle.toLowerCase()));
    let cursor = '', added = 0, pages = 0;

    while (pages < 10) {
      if (cancelled()) break;
      report('正在读取第 ' + (pages + 1) + ' 页，已获取 ' + added + ' 个…');
      const json = await withBootstrap(() => x.fetchFollowing(myId, cursor, 100));
      const users = collectUsers(json);
      // 响应里可能夹带你自己的 User 节点（viewer 信息），别把自己加进名单
      const fresh = users.filter((u) => u.id !== myId && !known.has(u.handle.toLowerCase()));
      for (const u of fresh) {
        known.add(u.handle.toLowerCase());
        // 新加进来的先按「常规」档起步，抓过一轮后自动归档
        list.push({ handle: u.handle, name: u.name, userId: u.id, enabled: true, tier: 'warm' });
        added++;
      }
      const next = readCursor(json);
      pages++;
      if (!next || next === cursor || !users.length) break;
      cursor = next;
      await sleep(1500);
    }

    await set(K.AUTHORS, list);
    await clearAttention();
    return { ok: true, added, total: list.length };
  } catch (e) {
    if (e.kind === 'auth' || e.kind === 'stale' || e.kind === 'setup') await raiseAttention(e.kind, e.message);
    return { ok: false, error: e.message };
  } finally {
    await x.releaseTab();
  }
}

/**
 * 模板没捕到（setup）时自动补一次再重试。
 * 只重试一次——补完还失败就是真出问题了，该提醒就提醒。
 */
async function withBootstrap(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e.kind !== 'setup') throw e;
    await x.bootstrap();
    return await fn();
  }
}

// ────────────────────────────── 抓取主流程 ──────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (pair) => pair[0] + Math.random() * (pair[1] - pair[0]);

// ────────────────────────────── 批次 ──────────────────────────────

/*
 * 只保留一个批次。
 *
 * 一个批次 = 一次「把当前该抓的博主抓完」的任务，带一条待办队列。
 * 每抓完一个博主就把队列和已收集的帖子落盘，所以中途取消、service worker
 * 被回收、甚至浏览器重启，下次都能从断点接着抓，而不是从头再来。
 *
 * 历史批次不留——帖子体积大，留着只会把 storage 撑爆。
 * 但 Grok 结论体积小、价值高，单独存在 DIGESTS 里，不随批次滚掉。
 */

const BATCH_MAX_AGE = 20 * 3600 * 1000;   // 超过这个岁数的未完成批次视为过期，重新开

function newBatch(due, skipped) {
  return {
    id: 'b' + Date.now(),
    startedAt: Date.now(),
    updatedAt: Date.now(),
    status: 'running',
    queue: due.map((a) => a.handle),   // 还没抓的
    doneHandles: [],
    total: due.length,
    skipped,
    posts: {},                          // id → tweet，天然去重
    failures: [],
    usedPool: false,
  };
}

async function loadResumableBatch() {
  const b = await get(K.BATCH, null);
  if (!b || b.status === 'done') return null;
  if (!b.queue || !b.queue.length) return null;
  if (Date.now() - b.startedAt > BATCH_MAX_AGE) return null;   // 太旧了，不如重开
  return b;
}

/** 当前批次里够格进汇总的帖子（过滤 + 排序在读取时做，不落盘） */
async function batchPosts(b, s) {
  return rank(Object.values((b && b.posts) || {}), s || await getSettings());
}

async function runDigest(opts) {
  const manual = !!(opts && opts.manual);
  const s = await getSettings();
  const all = await get(K.AUTHORS, []);
  const enabled = all.filter((a) => a.enabled !== false && a.handle);
  if (!enabled.length) return { ok: false, error: '还没有配置任何博主' };

  const now = Date.now();
  const byHandle = new Map(enabled.map((a) => [a.handle.toLowerCase(), a]));

  // 有未完成的批次就接着跑，没有才开新的
  let batch = await loadResumableBatch();
  const resumed = !!batch;
  if (!batch) {
    // 分档调度：高频的每天抓，低频的隔几天抓一次。
    // 手动触发时无视档位，全抓——你点了就是想立刻看到结果。
    const due = manual ? enabled : enabled.filter((a) => isDue(a, now));
    if (!due.length) return { ok: false, error: '这一轮没有到期的博主（按档位跳过了全部）' };
    batch = newBatch(due, enabled.length - due.length);
  }
  batch.status = 'running';

  const reported = new Set(await get(K.REPORTED, []));
  let hardKind = null;
  let wasCancelled = false;
  let fetched = 0;

  try {
    while (batch.queue.length) {
      if (cancelled()) { wasCancelled = true; break; }

      const handle = batch.queue[0];
      const a = byHandle.get(handle.toLowerCase());
      if (!a) { batch.queue.shift(); continue; }   // 期间被你删掉了

      report('(' + (batch.doneHandles.length + 1) + '/' + batch.total + ') @' + handle);
      try {
        if (!a.userId) {
          a.userId = await withBootstrap(() => x.resolveUserId(a.handle));
          await sleep(rand(s.delayMs));
        }

        const json = await withBootstrap(() => x.fetchUserTweets(a.userId, countFor(a)));
        const mine = collectTweets(json).filter(
          (t) => (t.author.handle || '').toLowerCase() === handle.toLowerCase()
        );

        // 节奏画像用这个博主的全部帖子算，不受时间窗影响
        updateCadence(a, mine, now);

        const since = lookbackSince(a, now, s.windowHours);
        for (const t of mine) {
          if (t.createdAt < since) continue;
          if (reported.has(t.id)) continue;
          batch.posts[t.id] = t;
        }
        fetched++;
      } catch (e) {
        batch.failures.push({ handle, kind: e.kind || 'net', msg: e.message });
        backoff(a, now);
        if (e.kind === 'auth' || e.kind === 'stale' || e.kind === 'setup') { hardKind = e.kind; break; }
      }

      // 断点就落在这里：出队 + 落盘。下次进来直接从队列头继续。
      batch.queue.shift();
      batch.doneHandles.push(handle);
      batch.updatedAt = Date.now();
      await set(K.BATCH, batch);
      await set(K.AUTHORS, all);

      await sleep(rand(s.delayMs));
    }
  } finally {
    batch.status = batch.queue.length ? 'paused' : 'done';
    batch.updatedAt = Date.now();
    await set(K.BATCH, batch);
    await set(K.AUTHORS, all);
    await x.releaseTab();
  }

  // 主动抓取全军覆没时，用被动囤积的池子兜底
  if (!Object.keys(batch.posts).length) {
    const pool = await get(K.POOL, {});
    const handles = new Set(enabled.map((a) => a.handle.toLowerCase()));
    const since = now - s.windowHours * 3600 * 1000;
    for (const t of Object.values(pool)) {
      if (t.createdAt >= since && !reported.has(t.id) && handles.has((t.author.handle || '').toLowerCase())) {
        batch.posts[t.id] = t;
      }
    }
    batch.usedPool = Object.keys(batch.posts).length > 0;
    await set(K.BATCH, batch);
  }

  if (hardKind) {
    const last = batch.failures[batch.failures.length - 1];
    await raiseAttention(hardKind, last && last.msg);
  } else if (wasCancelled) {
    // 用户主动取消，不是故障
  } else if (batch.failures.length && batch.failures.length >= batch.total) {
    await softFailure(batch.failures[0].kind, batch.failures[0].msg);
  } else {
    await clearAttention();
  }

  const posts = await batchPosts(batch, s);

  // 批次跑完才把 id 记进「已报过」，中途取消不记——否则续传时这些帖子会被自己滤掉
  if (batch.status === 'done') {
    for (const p of posts) reported.add(p.id);
    await set(K.REPORTED, Array.from(reported).slice(-3000));
  }

  if (posts.length && !manual && batch.status === 'done') {
    chrome.notifications.create('xfd-done-' + Date.now(), {
      type: 'basic', iconUrl: ICON,
      title: 'X Feed Digest — 今日汇总就绪',
      message: '收到 ' + posts.length + ' 条候选帖子' + (batch.usedPool ? '（来自本地缓存）' : '') + '，点击查看。',
      priority: 1,
    });
  }

  // 定时任务跑完自动分析；手动汇总不自动——那样才能随时停，
  // 停下来之后再单独对已保留的数据跑分析。
  let autoDigest = null;
  if (!manual && batch.status === 'done' && posts.length && s.autoGrok !== false) {
    autoDigest = await analyzeLatest();
  }

  return {
    ok: !hardKind && posts.length > 0,
    cancelled: wasCancelled,
    resumed,
    count: posts.length,
    fetched,
    remaining: batch.queue.length,
    total: batch.total,
    skipped: batch.skipped,
    failures: batch.failures,
    usedPool: batch.usedPool,
    autoDigest,
  };
}

/**
 * 对当前批次已收集的帖子做 Grok 分析。
 * 和抓取完全解耦：批次可以随时取消，取消后已收集的帖子照样能拿来分析，
 * 也可以换个角度反复重跑，不用重新抓一遍。
 *
 * 结论存进 DIGESTS（跟批次解耦，批次滚掉了结论还在）。
 */
async function analyzeLatest() {
  const s = await getSettings();
  const batch = await get(K.BATCH, null);
  const posts = await batchPosts(batch, s);
  if (!posts.length) return { ok: false, error: '当前批次没有可分析的帖子，先跑一次汇总' };

  try {
    report('正在打开 Grok 页面…');
    const tabId = await x.openScratchTab(grok.GROK_URL);
    if (cancelled()) return { ok: false, cancelled: true };

    // 不再固定 sleep 等页面就绪——drive() 自己会轮询等输入框挂载
    report('Grok 分析中（' + posts.length + ' 条帖子，约需 1 分钟）…');
    const lim = s.maxToGrok || 40;
    const sent = Math.min(posts.length, lim);   // 候选池是 maxToLLM 条，真送进去的只有 lim 条
    const { text, ms, via } = await grok.ask(tabId, grok.buildPrompt(posts, lim));

    const digests = await get(K.DIGESTS, []);
    digests.unshift({
      at: Date.now(),
      batchId: batch.id,
      postCount: sent,
      via,
      text,
      // 存下序号→原帖的映射，渲染结论时把编号变成可点的链接
      index: grok.buildIndex(posts, lim),
    });
    // 结论体积小，多留几条无所谓；帖子才是大头，那个只留当前批次
    await set(K.DIGESTS, digests.slice(0, 20));

    batch.digestAt = Date.now();
    batch.digestError = '';
    await set(K.BATCH, batch);

    return { ok: true, chars: text.length, posts: sent, ms, via };
  } catch (e) {
    if (e.kind === 'cancelled') return { ok: false, cancelled: true };
    if (batch) {
      // 盖上时间戳：界面上要能分清这是刚失败的，还是上次遗留下来的
      batch.digestError = e.message;
      batch.digestErrorAt = Date.now();
      await set(K.BATCH, batch);
    }
    return { ok: false, error: e.message };
  } finally {
    await x.releaseTab();
  }
}


const PER_AUTHOR_CAP = 3;

/**
 * 过滤 + 排序，选出送进模型的候选池。
 *
 * 不能按互动绝对值排。那等于先把大号的帖子整块排到前面，Grok 拿到候选池时
 * 小号的爆款早就被挤掉了——提示词里再怎么强调「看倍率」也无从看起。
 * 所以这里先做规模归一：互动除以 sqrt(粉丝数)。开方是为了压平基数优势，
 * 又不至于反过来让 300 粉拿 3 个赞的帖子登顶。
 *
 * 分母按整个批次统一选一次，不逐条挑：粉丝数和阅读量差着数量级，
 * 混着用等于在比两把不同刻度的尺子。取不到分母的那几条给中位数，
 * 既不白占便宜也不平白吃亏。
 */
function rank(list, s) {
  const eng = (t) => t.metrics.like + t.metrics.rt * 2 + t.metrics.quote * 2 + t.metrics.reply;

  /*
   * 「说说」：没图、没视频、没引用的纯文字短帖。
   *
   * 这类帖子的赞来自「谁说的」而不是「说了什么」——一个 5w 粉的号发两句话
   * 拿到的阅读量，新号原样复刻只会是零。送进 Grok 纯属浪费名额，还会挤掉
   * 真正能抄的结构化帖子。
   *
   * 但**只卡短的**。清单、对比、步骤、观点框架——最值得二创的那几类恰恰常常是
   * 纯文字长帖，按「纯文字」一刀切会把最有价值的一类一起杀掉。
   * 字数不算链接：两句话配一个长链接不该被算成长帖。
   */
  const plainLen = (t) => (t.text || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, '')
    .length;
  const isChatter = (t) =>
    !(t.media && t.media.length) && !t.isQuote && plainLen(t) < (s.plainMinChars || 0);

  /*
   * 互动率。**故意不带权重**，和 grok.js 印进 prompt 的那个数是同一个算法——
   * 界面上卡掉一条的理由，必须和 Grok 看到的数字对得上，否则查起来全是幻觉。
   * （排序用的 eng() 是另一回事，那里转发算两倍是为了排序，不是为了解释。）
   */
  const raw = (t) => t.metrics.like + t.metrics.rt + t.metrics.quote + t.metrics.reply;
  // 粉丝数取不到就返回 null：没有分母，这两条过滤一律不套用，别瞎杀
  const rateOf = (t) => (t.author.followers > 0 ? raw(t) / t.author.followers * 100 : null);

  const kept = list
    .filter((t) => !(s.dropRetweets && t.isRetweet))
    .filter((t) => !(s.dropReplies && t.isReply))
    .filter((t) => t.metrics.like >= (s.minLikes || 0))
    .filter((t) => !(s.dropPlainShort && isChatter(t)))
    // 名人效应：绝对数高但占粉丝比例低
    .filter((t) => { const r = rateOf(t); return r === null || !(s.minEngageRate > 0 && r < s.minEngageRate); })
    // 兜底：大 V 偶尔真有一条爆的，率也够，但那依然是名气在托着
    .filter((t) => !(s.maxFollowers > 0 && t.author.followers > s.maxFollowers))
    .filter((t) => (t.text || '').trim().length > 0);

  const byFollowers = kept.filter((t) => t.author.followers > 0).length > kept.length / 2;
  const basisOf = (t) => (byFollowers ? t.author.followers : t.metrics.views) || 0;

  const known = kept.map(basisOf).filter((v) => v > 0).sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 0;
  const score = (t) => {
    const b = basisOf(t) || median;
    return b > 0 ? eng(t) / Math.sqrt(b) : eng(t);
  };

  // 同一个博主最多进 PER_AUTHOR_CAP 条，别让一个高产账号把池子占满
  const seen = new Map();
  const out = [];
  for (const t of kept.sort((a, b) => score(b) - score(a))) {
    const h = (t.author.handle || '').toLowerCase();
    const n = (seen.get(h) || 0) + 1;
    if (n > PER_AUTHOR_CAP) continue;
    seen.set(h, n);
    out.push(t);
    if (out.length >= s.maxToLLM) break;
  }
  return out;
}

// ────────────────────────────── 定时 ──────────────────────────────

/*
 * 执行日志。定时任务最难受的地方是它不出声——没跑就是什么都没有，
 * 你分不清是「没到点」「到点了没醒」还是「跑了但失败了」。所以每一个环节
 * 都留一行：排期、闹钟响、开跑、结果、被跳过。环形保留最近 200 条。
 */
const RUNLOG_CAP = 200;

async function logRun(kind, text) {
  const list = await get(K.RUNLOG, []);
  list.push({ at: Date.now(), kind, text: String(text || '') });
  await set(K.RUNLOG, list.slice(-RUNLOG_CAP));
  try { chrome.runtime.sendMessage({ cmd: 'runLogged' }, () => void chrome.runtime.lastError); } catch (e) {}
}

/** 上一个本该执行的时刻（今天的 hh:mm 如果已过，否则昨天的） */
function prevSlot(s) {
  const d = new Date();
  d.setHours(s.hour, s.minute, 0, 0);
  if (d.getTime() > Date.now()) d.setDate(d.getDate() - 1);
  return d.getTime();
}

/*
 * opts.catchUp：浏览器启动 / 扩展装好时传 true。
 *
 * 这里原来有个会让定时**永远不执行**的坑：schedule() 一上来就 alarms.clear()，
 * 然后无条件排到「下一个 hh:mm」。而 Chrome 关着的时候闹钟不会响，只会在下次启动后
 * 补响——可 onStartup 又先调了 schedule()，那个欠着的闹钟当场被清掉，接着排到明天。
 * 于是只要你不是恰好在 9:00 开着浏览器，这件事就一天拖一天，永远轮不到。
 * 现在改成：启动时先看上一个时刻有没有跑过，漏了就当场补跑。
 */
async function schedule(opts) {
  await chrome.alarms.clear(ALARM_DAILY);
  const s = await getSettings();
  if (!s.enabled) { await logRun('sched', '定时已关闭'); return; }

  // 测试档：每 N 分钟跑一次，不看时刻。用来确认这条链路是通的。
  const every = Number(s.everyMinutes) || 0;
  if (every > 0) {
    const m = Math.max(1, every);
    chrome.alarms.create(ALARM_DAILY, { delayInMinutes: m, periodInMinutes: m });
    await logRun('sched', '测试模式：每 ' + m + ' 分钟跑一次，下次 ' + new Date(Date.now() + m * 60000).toLocaleTimeString());
    return;
  }

  const next = new Date();
  next.setHours(s.hour, s.minute, 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  chrome.alarms.create(ALARM_DAILY, { when: next.getTime(), periodInMinutes: 24 * 60 });
  await logRun('sched', '下次 ' + next.toLocaleString());

  if (opts && opts.catchUp) {
    const slot = prevSlot(s);
    const last = await get(K.LASTRUN, 0);
    if (last < slot) {
      await logRun('catchup', '上一次 ' + new Date(slot).toLocaleString() + ' 的汇总没跑成，现在补上');
      fire('补跑');
    }
  }
}

/*
 * 一轮汇总的结果写成一行日志。「一条都没有」不是失败——可能只是这个时间窗里
 * 大家都没发帖，写成「失败」会让人白查一圈。
 */
function digestLine(r) {
  if (!r) return ['fail', '没有返回结果'];
  if (r.cancelled) return ['skip', '已取消，保留 ' + (r.count || 0) + ' 条'];
  if (r.error) return ['fail', r.error];
  if (!r.count) return ['done', '跑完了，但这个时间窗里没有符合条件的帖子'];
  return ['done', '完成，' + r.count + ' 条（抓了 ' + (r.fetched || 0) + ' 个博主'
    + (r.skipped ? '，按档位跳过 ' + r.skipped + ' 个' : '') + '）'];
}

/** 闹钟/补跑的统一入口：谁触发的、跑没跑成，都记一行 */
function fire(why) {
  logRun('fire', why + ' 触发');
  if (job) { logRun('skip', '有「' + (job.label || job.name) + '」在跑，这次跳过'); return; }
  withJob('digest', async () => {
    await set(K.LASTRUN, Date.now());
    const r = await runDigest();
    await logRun(...digestLine(r));
    if (r && r.autoDigest && !r.autoDigest.ok && !r.autoDigest.cancelled) {
      await logRun('fail', 'Grok 分析失败：' + (r.autoDigest.error || '未知'));
    }
    return r;
  }).catch((e) => logRun('fail', String((e && e.message) || e)));
}

chrome.alarms.onAlarm.addListener((al) => {
  // 定时任务同样受锁约束：你手动点着的时候它不该插队
  if (al.name === ALARM_DAILY) fire('闹钟');
});

// 装好 / 浏览器启动时就把模板准备好，别等你打开面板才发现没装好
chrome.runtime.onInstalled.addListener(() => { schedule({ catchUp: true }); ensureReady().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { schedule({ catchUp: true }); ensureReady().catch(() => {}); });
