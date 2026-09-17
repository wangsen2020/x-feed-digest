import { K, get, set, getSettings } from './src/store.js';
import { TIERS } from './src/cadence.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
const when = (t) => new Date(t).toLocaleString();

const REASON = {
  setup: ['还没装好', '需要先在 x.com 上捕获一次接口调用参数。点右边的按钮，扩展会自己开个后台页面搞定。'],
  auth:  ['凭证已失效', '登录态或 CSRF token 变了。打开 x.com 正常浏览一下即可自动重新捕获。'],
  stale: ['接口版本已变更', 'X 前端发版，接口参数对不上了。打开 x.com 刷一下首页即可自动更新模板。'],
  rate:  ['连续被限流', '请求被 X 限流多次，已自动放慢节奏，可稍后重试。'],
  net:   ['网络异常', '连续多次请求失败，可能是网络或 X 服务端问题。'],
};

// ─────────────── 任务遮罩 ───────────────

/*
 * 后台一次只跑一个任务（互斥锁在 background.js 里）。
 * 这里只是把那个状态如实反映到界面上：跑着的时候挡住所有交互，
 * 省得你点了没反应、或者收到一条莫名其妙的失败提示。
 */
const GATED = ['run', 'resume', 'reset', 'save', 'addAuthor', 'importFollowing',
               'bannerFix', 'newAuthor', 'analyze', 'copyDigest'];

function setBusy(job) {
  const on = !!job;
  $('overlay').classList.toggle('show', on);
  if (on) {
    $('ovTitle').textContent = job.label || '处理中';
    $('ovProgress').textContent = job.progress || '';
    $('ovCancel').disabled = !!job.cancelling;
    $('ovCancel').textContent = job.cancelling ? '正在收尾…' : '取消';
  }
  for (const id of GATED) {
    const el = $(id);
    if (el) el.disabled = on;
  }
}

/** 面板打开时后台可能正跑着定时任务，先问一次 */
function syncBusy() {
  chrome.runtime.sendMessage({ cmd: 'jobStatus' }, (r) => {
    if (chrome.runtime.lastError) return;
    setBusy(r && r.job);
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.cmd === 'jobState') setBusy(msg.job);
  if (msg && msg.cmd === 'runLogged') paintLog();
});

$('ovCancel').addEventListener('click', () => {
  $('ovCancel').disabled = true;
  $('ovCancel').textContent = '正在收尾…';
  chrome.runtime.sendMessage({ cmd: 'cancelJob' }, () => void chrome.runtime.lastError);
});

/** 统一的「发一条命令并等它跑完」：遮罩由 jobState 广播驱动，这里只管结果 */
function call(cmd, done) {
  chrome.runtime.sendMessage({ cmd }, (r) => {
    if (chrome.runtime.lastError) { $('msg').textContent = chrome.runtime.lastError.message; setBusy(null); return; }
    if (!r) { $('msg').textContent = '后台无响应'; setBusy(null); return; }
    if (r.busy) { $('msg').textContent = r.error; return; }   // 锁挡下来了，别当失败
    done(r);
    paintAll();
  });
}

// ─────────────── 顶部告警条 ───────────────

async function paintBanner() {
  const h = await get(K.HEALTH, {});
  const tpl = await get(K.TEMPLATES, {});
  const missing = !(tpl.UserOriginalsTimeline || tpl.UserTweets) || !tpl.UserByScreenName;

  // auth / stale 得你本人去刷 x.com，才算「需要处理」；
  // setup / 没捕获过是能自愈的，不该红着挂在这里等你点。
  const mustAsk = h.needsAttention && h.state !== 'setup';

  let title = '', body = '', selfHealable = false;
  if (mustAsk) {
    const r = REASON[h.state] || REASON.net;
    title = r[0];
    body = r[1] + (h.reason ? '（' + h.reason + '）' : '');
  } else if (missing) {
    title = '正在自动准备';
    body = '首次使用需要捕获一次接口参数，扩展会自己开一个后台页面完成，不用你动手。';
    selfHealable = true;
  }

  $('banner').classList.toggle('show', !!title);
  $('banner').classList.toggle('info', selfHealable);
  $('bannerTitle').textContent = title;
  $('bannerBody').textContent = body;
  $('bannerFix').textContent = selfHealable ? '立即捕获' : '打开 x.com 重新捕获';

  if (selfHealable) selfHeal();
}

/*
 * 模板没捕获时自动补，不用你点。
 * 后台 ensureReady 有 10 分钟节流和互斥锁，不会反复开后台窗口。
 */
// tried 这道闸不能省：selfHeal 的回调会重绘界面，重绘又会调用 selfHeal，
// 没有它就是一个无限互发消息的死循环。每次打开页面只自动尝试一次。
let healing = false, tried = false;
function selfHeal() {
  if (healing || tried) return;
  healing = true;
  tried = true;
  chrome.runtime.sendMessage({ cmd: 'ensureReady' }, (r) => {
    healing = false;
    if (chrome.runtime.lastError) return;
    if (r && r.ok && !r.already) $('msg').textContent = '接口参数已就绪';
    paintAll();
  });
}

// setup 能自愈（扩展自己开后台页捕获）；auth / stale 得你本人去刷 x.com
$('bannerFix').addEventListener('click', async () => {
  const h = await get(K.HEALTH, {});
  // auth / stale 自动开窗也解决不了，得你本人去刷
  if (h.needsAttention && h.state !== 'setup') { chrome.tabs.create({ url: 'https://x.com/home' }); return; }
  tried = false;   // 你主动点了，就放开自动尝试的闸

  call('bootstrap', (r) => {
    if (r.ok) {
      $('msg').textContent = '已捕获：' + (r.captured || []).join('、')
        + (r.handle ? '（账号 @' + r.handle + '）' : '');
    } else {
      const got = (r.captured && r.captured.length) ? '；已抓到：' + r.captured.join('、') : '';
      $('msg').textContent = '捕获失败：' + r.error + got;
    }
  });
});

// ─────────────── 博主名单（默认折叠） ───────────────

async function paintAuthors() {
  const list = await get(K.AUTHORS, []);
  const box = $('authors');
  box.textContent = '';

  // 折叠时只看得到摘要行，所以统计要说清楚：总数 + 停用数 + 各档分布
  const off = list.filter((a) => a.enabled === false).length;
  const byTier = {};
  for (const a of list) {
    const k = a.tier || 'warm';
    byTier[k] = (byTier[k] || 0) + 1;
  }
  const dist = Object.keys(TIERS).filter((k) => byTier[k])
    .map((k) => TIERS[k].label + ' ' + byTier[k]).join(' · ');
  $('authorCount').textContent = list.length
    ? list.length + ' 个' + (off ? '（停用 ' + off + '）' : '') + (dist ? ' · ' + dist : '')
    : '空';

  if (!list.length) {
    const p = document.createElement('span');
    p.className = 'hint';
    p.textContent = '还没有添加博主。';
    box.appendChild(p);
    return;
  }

  for (const a of list) {
    const chip = document.createElement('span');
    chip.className = 'chip' + (a.enabled === false ? ' off' : '');

    const name = document.createElement('span');
    name.textContent = '@' + a.handle;
    name.style.cursor = 'pointer';
    name.title = a.enabled === false ? '点击启用' : '点击暂停';
    name.addEventListener('click', async () => {
      a.enabled = a.enabled === false;
      await set(K.AUTHORS, list);
      paintAuthors();
    });

    const tk = a.tier || 'warm';
    const tier = document.createElement('span');
    tier.className = 'tier ' + tk;
    tier.textContent = TIERS[tk].label + (a.rate !== undefined ? ' ' + a.rate.toFixed(1) + '/天' : '');
    tier.title = a.nextDueAt ? '下次抓取：' + when(a.nextDueAt) : '还没抓过，下轮就会抓';

    const del = document.createElement('button');
    del.textContent = '×';
    del.title = '移除';
    del.addEventListener('click', async () => {
      await set(K.AUTHORS, list.filter((it) => it.handle !== a.handle));
      paintAuthors();
    });

    chip.append(name, tier, del);
    box.appendChild(chip);
  }
}

$('addAuthor').addEventListener('click', async () => {
  const raw = $('newAuthor').value.trim();
  if (!raw) return;
  const list = await get(K.AUTHORS, []);
  const known = new Set(list.map((a) => a.handle.toLowerCase()));

  for (const part of raw.split(/[\s,，]+/)) {
    const handle = part.replace(/^@/, '').replace(/^https?:\/\/(x|twitter)\.com\//i, '').split(/[/?]/)[0].trim();
    if (!handle || known.has(handle.toLowerCase())) continue;
    known.add(handle.toLowerCase());
    list.push({ handle, userId: '', enabled: true });
  }
  await set(K.AUTHORS, list);
  $('newAuthor').value = '';
  paintAuthors();
});

$('newAuthor').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('addAuthor').click(); });

$('importFollowing').addEventListener('click', () => {
  $('msg').textContent = '';
  call('importFollowing', (r) => {
    $('msg').textContent = r.ok ? '导入 ' + r.added + ' 个，共 ' + r.total + ' 个' : '失败：' + r.error;
  });
});

// ─────────────── 设置 ───────────────

const FIELDS = ['windowHours', 'maxToLLM', 'minLikes', 'maxToGrok', 'hour', 'minute', 'everyMinutes', 'plainMinChars', 'minEngageRate', 'maxFollowers'];
const FLAGS = ['dropRetweets', 'dropReplies', 'autoGrok', 'enabled', 'dropPlainShort'];

async function paintSettings() {
  const s = await getSettings();
  for (const k of FIELDS) $(k).value = s[k];
  for (const k of FLAGS) $(k).checked = !!s[k];
}

$('save').addEventListener('click', async () => {
  const s = await getSettings();
  for (const k of FIELDS) s[k] = Number($(k).value) || 0;
  for (const k of FLAGS) s[k] = $(k).checked;
  await set(K.SETTINGS, s);
  // 时刻改了闹钟不会自己跟着变，必须让后台重排一次——否则改完看着生效了，
  // 实际还按旧时间响。
  chrome.runtime.sendMessage({ cmd: 'reschedule' }, () => { void chrome.runtime.lastError; paintLog(); });
  $('msg').textContent = '已保存';
  setTimeout(() => ($('msg').textContent = ''), 1800);
});

// ─────────────── 执行日志 ───────────────

const LOG_KIND = {
  sched: '排期', fire: '触发', catchup: '补跑', manual: '手动',
  skip: '跳过', done: '完成', fail: '失败',
};

function paintLog() {
  chrome.runtime.sendMessage({ cmd: 'runLog' }, (r) => {
    if (chrome.runtime.lastError || !r) return;
    const box = $('runLog');
    box.textContent = '';
    const list = (r.log || []).slice().reverse();  // 新的在上面
    $('logCount').textContent = list.length ? list.length + ' 条' : '还没有记录';
    $('nextRun').textContent = r.next
      ? '下次 ' + when(r.next) + (r.last ? ' · 上次跑于 ' + when(r.last) : ' · 还没跑过')
      : '未排期（定时没启用？）';

    if (!list.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = '还没有记录。定时一次都没触发过的话，这里就是空的——这本身就是个信号。';
      box.appendChild(e);
      return;
    }
    for (const it of list) {
      const row = document.createElement('div');
      row.className = 'r ' + it.kind;
      const t = document.createElement('span'); t.className = 't'; t.textContent = when(it.at);
      const k = document.createElement('span'); k.className = 'k'; k.textContent = LOG_KIND[it.kind] || it.kind;
      const m = document.createElement('span'); m.className = 'm'; m.textContent = it.text;
      row.append(t, k, m);
      box.appendChild(row);
    }
  });
}

$('refreshLog').addEventListener('click', paintLog);
$('clearLog').addEventListener('click', () => {
  chrome.runtime.sendMessage({ cmd: 'clearRunLog' }, () => { void chrome.runtime.lastError; paintLog(); });
});

$('run').addEventListener('click', () => {
  $('msg').textContent = '';
  call('runNow', (r) => {
    $('msg').textContent = r.cancelled
      ? '已暂停，保留 ' + r.count + ' 条；剩 ' + r.remaining + ' 个博主，下次从断点继续'
      : r.ok
        ? '完成，' + r.count + ' 条（抓了 ' + r.fetched + ' 个博主'
          + (r.skipped ? '，按档位跳过 ' + r.skipped + ' 个' : '') + '）'
        : '失败：' + (r.error || (r.failures && r.failures[0] && r.failures[0].msg) || '无数据');
    if (r.autoDigest && !r.autoDigest.ok && !r.autoDigest.cancelled) {
      $('msg').textContent += ' · 自动分析失败：' + r.autoDigest.error;
    }
  });
});

// ─────────────── 批次 ───────────────

async function paintBatch() {
  const b = await get(K.BATCH, null);
  const info = $('batchInfo');

  if (!b) {
    info.textContent = '还没有批次。点「立即汇总一次」开始。';
    $('resume').style.display = 'none';
    $('reset').style.display = 'none';
    return;
  }

  const n = Object.keys(b.posts || {}).length;
  const doneN = (b.doneHandles || []).length;
  const label = b.status === 'done' ? '已完成' : b.status === 'paused' ? '已暂停' : '进行中';

  info.textContent = '批次' + label + ' · 博主 ' + doneN + '/' + b.total
    + '（剩 ' + (b.queue || []).length + '）· 已收集 ' + n + ' 条 · ' + when(b.updatedAt)
    + (b.failures && b.failures.length ? ' · ' + b.failures.length + ' 个失败' : '');

  // 只有还有剩余队列时才给「继续抓取」——它从断点接着跑，不重头来
  const unfinished = b.status !== 'done' && (b.queue || []).length > 0;
  $('resume').style.display = unfinished ? '' : 'none';
  $('reset').style.display = unfinished ? '' : 'none';
}

$('resume').addEventListener('click', () => {
  $('msg').textContent = '';
  call('runNow', (r) => {
    $('msg').textContent = r.cancelled
      ? '已暂停，剩 ' + r.remaining + ' 个博主（下次从这里继续）'
      : r.ok ? '批次完成，共 ' + r.count + ' 条' : '失败：' + (r.error || '无数据');
  });
});

$('reset').addEventListener('click', () => {
  if (!confirm('放弃当前批次的队列和已收集的帖子，重新开始？分析历史不会丢。')) return;
  chrome.runtime.sendMessage({ cmd: 'resetBatch' }, () => { void chrome.runtime.lastError; paintAll(); });
});

// ─────────────── 当前结论 ───────────────

/**
 * 当前批次里 handle → 最新一条原帖 URL。
 * 专门用来救旧记录：它们没有 index 映射，靠这张表还能定位到帖子。
 */
async function handleMap() {
  const batch = await get(K.BATCH, null);
  const m = new Map();
  const list = batch && batch.posts ? Object.values(batch.posts) : [];
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  for (const t of list) {
    const h = (t.author.handle || '').toLowerCase();
    if (h && t.url && !m.has(h)) m.set(h, t.url);
  }
  return m;
}

/** 当前批次对应的那条结论；没有就退回最新一条 */
async function currentDigest() {
  const batch = await get(K.BATCH, null);
  const digests = await get(K.DIGESTS, []);
  const cur = digests.find((d) => batch && d.batchId === batch.id);
  return { batch, digests, cur, shown: cur || digests[0] };
}

async function paintDigest() {
  const { batch, cur, shown } = await currentDigest();
  const sec = $('digestSec');
  const box = $('digest');
  const n = batch && batch.posts ? Object.keys(batch.posts).length : 0;

  if (!n && !shown) { sec.style.display = 'none'; return; }
  sec.style.display = '';

  if (shown) {
    box.className = 'digest';
    renderDigest(box, shown.text, shown.index, await handleMap());
    // 有旧结论时也得把「本批次分析失败了」说出来。
    // 否则界面只是安静地显示上一批的结论，你根本不知道今天这次其实失败了。
    const stale = !cur && batch && batch.digestError;
    $('digestMeta').textContent = '基于 ' + shown.postCount + ' 条帖子 · ' + when(shown.at)
      + (cur ? '' : '（上一批次的结论）')
      + (stale ? ' · 本批次分析失败：' + batch.digestError
                 + (batch.digestErrorAt ? '（' + when(batch.digestErrorAt) + '）' : '') : '')
      + (shown.index ? '' : ' · 旧记录，原帖链接靠 @作者 反查，重新分析可获得精确链接');
    $('digestMeta').classList.toggle('err', !!stale);
    $('copyDigest').style.display = '';
    $('analyze').textContent = cur ? '重新分析' : '分析当前批次';
  } else if (batch && batch.digestError) {
    box.className = 'digest err';
    box.textContent = 'Grok 分析失败：' + batch.digestError
      + (batch.digestErrorAt ? String.fromCharCode(10) + '失败时间：' + when(batch.digestErrorAt) : '')
      + String.fromCharCode(10) + '（帖子照常保留，可以直接重试）';
    $('digestMeta').textContent = '';
    $('copyDigest').style.display = 'none';
    $('analyze').textContent = '重试分析';
  } else {
    box.className = 'digest';
    box.textContent = '当前批次已保留 ' + n + ' 条帖子，还没让 Grok 分析过。';
    $('digestMeta').textContent = '';
    $('copyDigest').style.display = 'none';
    $('analyze').textContent = '用 Grok 分析';
  }
  $('analyze').disabled = !n;
}

$('analyze').addEventListener('click', () => {
  $('msg').textContent = '';
  call('analyze', (r) => {
    $('msg').textContent = r.cancelled ? '已取消分析'
      : r.ok ? 'Grok 分析完成（' + r.chars + ' 字，基于 ' + r.posts + ' 条帖子，'
          + Math.round(r.ms / 1000) + ' 秒，' + (r.via === 'dom' ? '读自页面' : '截自响应流') + '）'
      : '分析失败：' + r.error;
  });
});

async function copy(text, btn, restore) {
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = '已复制';
    setTimeout(() => (btn.textContent = restore), 1500);
  } catch (e) {}
}

$('copyDigest').addEventListener('click', async () => {
  const { shown } = await currentDigest();
  if (shown) await copy(shown.text, $('copyDigest'), '复制全文');
});


// ─────────────── 文本里的 @handle 链接化 ───────────────

/** 把一段纯文本渲染进容器，其中的 @handle 变成指向主页的链接 */
function renderMentions(box, text) {
  box.textContent = '';
  const re = /@([A-Za-z0-9_]{1,15})/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) box.appendChild(document.createTextNode(text.slice(last, m.index)));
    const a = document.createElement('a');
    a.href = 'https://x.com/' + m[1];
    a.target = '_blank'; a.rel = 'noreferrer';
    a.textContent = m[0];
    box.appendChild(a);
    last = m.index + m[0].length;
  }
  box.appendChild(document.createTextNode(text.slice(last)));
}

// ─────────────── 结论渲染（把编号和 @handle 变成链接） ───────────────

/*
 * Grok 的回答每条以「31 @AYi_AInotes 一句话概括」开头，31 是 prompt 里的序号。
 * 分析时存下的 index 表把序号映射回原帖 URL，这里据此还原成可点的链接。
 *
 * 全程用 DOM 拼，不碰 innerHTML——正文是模型输出，不能当 HTML 塞进页面。
 */
function renderDigest(box, text, index, byHandle) {
  box.textContent = '';
  const byN = new Map((index || []).map((it) => [String(it.n), it]));

  /*
   * 定位原帖，三级回退：
   *   1. 序号 → index 映射（分析时存下的，最准）
   *   2. index 里按 @handle 找（序号对不上时，比如 Grok 改了编号）
   *   3. 当前批次里按 @handle 找（救老记录——它们根本没有 index）
   * 都找不到就不渲染链接，而不是渲染一个坏链接。
   */
  const resolve = (n, handle) => {
    const hit = byN.get(n);
    if (hit && hit.url) return hit.url;
    const h = (handle || '').toLowerCase();
    const byIdx = (index || []).find((it) => (it.handle || '').toLowerCase() === h);
    if (byIdx && byIdx.url) return byIdx.url;
    return (byHandle && byHandle.get(h)) || '';
  };

  const link = (href, label, cls) => {
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.textContent = label;
    if (cls) a.className = cls;
    return a;
  };

  // 条目首行：「31 @handle 概括」或「#31. @handle」或干脆只有「@handle」。
  // 序号必须是可选的——Grok 有时候直接不编号，这时靠 @作者 定位原帖。
  const HEAD = /^\s*(?:#?(\d{1,3})\s*[.、)]?\s+)?@([A-Za-z0-9_]{1,15})\s*(.*)$/;
  const MENTION = /@([A-Za-z0-9_]{1,15})/g;

  for (const raw of String(text).split(String.fromCharCode(10))) {
    const line = document.createElement('div');

    // 条目首行：「31 @handle 一句话概括……」
    const head = HEAD.exec(raw);
    if (head) {
      const n = head[1] || '', handle = head[2], rest = head[3];
      const url = resolve(n, handle);
      line.className = 'dItem';

      // Grok 不一定编号。有序号就画成标签，没有就直接从 @作者 开始。
      if (n) {
        if (url) {
          line.appendChild(link(url, '#' + n, 'dNum'));
        } else {
          const sp = document.createElement('span');
          sp.className = 'dNum';
          sp.textContent = '#' + n;
          line.appendChild(sp);
        }
        line.appendChild(document.createTextNode(' '));
      }
      line.appendChild(link('https://x.com/' + handle, '@' + handle));
      if (rest) line.appendChild(document.createTextNode(' ' + rest));

      // 一个小小的 #31 太不显眼，每条末尾再给一个明确的原帖入口
      if (url) {
        line.appendChild(document.createTextNode(' '));
        line.appendChild(link(url, '原帖 ↗', 'dLink'));
      }

      box.appendChild(line);
      continue;
    }

    // 正文里零散出现的 @handle 也顺手链上
    let last = 0, m;
    MENTION.lastIndex = 0;
    while ((m = MENTION.exec(raw))) {
      if (m.index > last) line.appendChild(document.createTextNode(raw.slice(last, m.index)));
      line.appendChild(link('https://x.com/' + m[1], m[0]));
      last = m.index + m[0].length;
    }
    line.appendChild(document.createTextNode(raw.slice(last)));
    box.appendChild(line);
  }
}

// ─────────────── 右栏：分析历史 ───────────────

async function paintHistory() {
  const batch = await get(K.BATCH, null);
  const digests = await get(K.DIGESTS, []);
  const box = $('histList');
  box.textContent = '';
  $('histCount').textContent = digests.length ? digests.length + ' 条' : '';

  if (!digests.length) {
    const d = document.createElement('div');
    d.className = 'hint';
    d.textContent = '还没有分析记录。';
    box.appendChild(d);
    return;
  }

  digests.forEach((d, idx) => {
    const item = document.createElement('div');
    item.className = 'histItem' + (batch && d.batchId === batch.id ? ' cur' : '');

    const m = document.createElement('div');
    m.className = 'm';
    const w = document.createElement('div');
    w.className = 'when';
    w.textContent = when(d.at) + ' · ' + d.postCount + ' 条';
    const peek = document.createElement('div');
    peek.className = 'peek';
    peek.textContent = (d.text || '').replace(/\s+/g, ' ').slice(0, 90);
    m.append(w, peek);

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = '删除这条记录';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();   // 别让删除冒泡成「打开详情」
      if (!confirm('删除这条分析记录？')) return;
      await removeDigest(idx);
    });

    item.addEventListener('click', () => openModal(idx));
    item.append(m, del);
    box.appendChild(item);
  });
}

async function removeDigest(idx) {
  const digests = await get(K.DIGESTS, []);
  digests.splice(idx, 1);
  await set(K.DIGESTS, digests);
  closeModal();
  paintAll();
}

// ─────────────── 详情弹窗 ───────────────

let modalIdx = -1;

async function openModal(idx) {
  const digests = await get(K.DIGESTS, []);
  const d = digests[idx];
  if (!d) return;
  modalIdx = idx;
  $('mTitle').textContent = when(d.at) + ' · 基于 ' + d.postCount + ' 条帖子';
  renderDigest($('mBody'), d.text, d.index, await handleMap());
  $('mCopy').textContent = '复制';
  $('modal').classList.add('show');
}

function closeModal() {
  modalIdx = -1;
  $('modal').classList.remove('show');
}

$('mClose').addEventListener('click', closeModal);
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

$('mCopy').addEventListener('click', async () => {
  const digests = await get(K.DIGESTS, []);
  const d = digests[modalIdx];
  if (d) await copy(d.text, $('mCopy'), '复制');
});
$('mDelete').addEventListener('click', async () => {
  if (modalIdx < 0) return;
  if (!confirm('删除这条分析记录？')) return;
  await removeDigest(modalIdx);
});

// ─────────────── 诊断 ───────────────

async function paintDiag() {
  const tpl = await get(K.TEMPLATES, {});
  const health = await get(K.HEALTH, {});
  const pool = await get(K.POOL, {});
  const batch = await get(K.BATCH, null);
  const digests = await get(K.DIGESTS, []);

  const healthText = health.needsAttention
    ? '需要处理：' + (REASON[health.state] || REASON.net)[0] : '正常';
  $('diagSub').textContent = healthText;

  const rows = [
    ['健康状态', healthText],
    ['UserByScreenName 模板', tpl.UserByScreenName
      ? tpl.UserByScreenName.queryId + ' · ' + when(tpl.UserByScreenName.at) : '未捕获'],
    ['时间线模板', tpl.UserOriginalsTimeline
      ? 'UserOriginalsTimeline · ' + tpl.UserOriginalsTimeline.queryId
      : (tpl.UserTweets ? 'UserTweets · ' + tpl.UserTweets.queryId : '未捕获')],
    ['关注列表模板', tpl.Following ? tpl.Following.queryId : '未捕获（打开一次「正在关注」页面）'],
    ['被动缓存池', Object.keys(pool).length + ' 条'],
    ['当前批次', batch
      ? batch.id + ' · ' + batch.status + ' · ' + when(batch.updatedAt)
        + (batch.usedPool ? '（用了缓存池）' : '')
      : '无'],
    ['结论历史', digests.length + ' 条'],
  ];

  if (batch && batch.failures && batch.failures.length) {
    rows.push(['失败记录', batch.failures.map((f) => '@' + f.handle + ': ' + f.msg)
      .join(String.fromCharCode(10))]);
  }

  const tb = $('diag');
  tb.textContent = '';
  for (const [k, v] of rows) {
    const tr = document.createElement('tr');
    const a = document.createElement('td'); a.textContent = k;
    const b = document.createElement('td'); b.textContent = v; b.style.whiteSpace = 'pre-wrap';
    tr.append(a, b);
    tb.appendChild(tr);
  }
}

// ─────────────── 当前批次的帖子 ───────────────

async function paintPosts() {
  const batch = await get(K.BATCH, null);
  const box = $('posts');
  box.textContent = '';

  const list = batch && batch.posts ? Object.values(batch.posts) : [];
  if (!list.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = '还没有数据，点「立即汇总一次」试试。';
    box.appendChild(d);
    $('runMeta').textContent = '空';
    return;
  }

  // 排序口径和后台一致：互动量加权
  const score = (t) => t.metrics.like + t.metrics.rt * 2 + t.metrics.quote * 2 + t.metrics.reply;
  list.sort((a, b) => score(b) - score(a));

  $('runMeta').textContent = list.length + ' 条 · ' + when(batch.updatedAt)
    + (batch.usedPool ? ' · 来自本地缓存' : '');

  for (const t of list) {
    const card = document.createElement('div');
    card.className = 'post';

    const head = document.createElement('div');
    head.className = 'head';

    // 作者名直接链到主页，省得复制 handle 再去搜
    const nm = document.createElement('b');
    const who = document.createElement('a');
    who.href = 'https://x.com/' + t.author.handle;
    who.target = '_blank'; who.rel = 'noreferrer';
    who.textContent = (t.author.name || t.author.handle) + ' @' + t.author.handle;
    nm.appendChild(who);

    // 时间本身就是通往原帖的链接（和 X 上的习惯一致）
    const tm = t.url ? document.createElement('a') : document.createElement('span');
    if (t.url) { tm.href = t.url; tm.target = '_blank'; tm.rel = 'noreferrer'; }
    tm.textContent = t.createdAt ? when(t.createdAt) : '';
    head.append(nm, tm);

    const body = document.createElement('div');
    body.className = 'body';
    renderMentions(body, t.text);

    const foot = document.createElement('div');
    foot.className = 'foot';
    const m = t.metrics;
    for (const [label, v] of [['♥', m.like], ['↻', m.rt], ['💬', m.reply], ['❝', m.quote], ['👁', m.views]]) {
      if (!v) continue;
      const s = document.createElement('span');
      s.textContent = label + ' ' + fmt(v);
      foot.appendChild(s);
    }
    if (t.url) {
      const a = document.createElement('a');
      a.href = t.url; a.target = '_blank'; a.rel = 'noreferrer';
      a.textContent = '原帖';
      foot.appendChild(a);
    }

    card.append(head, body, foot);
    box.appendChild(card);
  }
}

// ─────────────── 折叠状态记忆 ───────────────

/*
 * 折叠区默认收起（名单多了很占地方），但每次打开面板都收回去也烦人。
 * 记住你上次的开合状态。这只是个人便利，丢了也无所谓，所以用 localStorage
 * 并且整段 try/catch——隐私窗口或站点数据被清时它会抛。
 */
function initFolds() {
  const folds = document.querySelectorAll('details.fold');
  folds.forEach((d, i) => {
    const key = 'xfd.fold.' + (d.id || i);
    try { if (localStorage.getItem(key) === '1') d.open = true; } catch (e) {}
    d.addEventListener('toggle', () => {
      try { localStorage.setItem(key, d.open ? '1' : '0'); } catch (e) {}
    });
  });
}

// ─────────────── 入口 ───────────────

function paintAll() {
  paintBanner(); paintAuthors(); paintSettings();
  paintBatch(); paintDigest(); paintHistory(); paintDiag(); paintPosts(); paintLog();
}
initFolds();
paintAll();
syncBusy();

// 后台写 storage 时实时刷新，不用手动 F5
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[K.HEALTH] || changes[K.TEMPLATES]) { paintBanner(); paintDiag(); }
  if (changes[K.BATCH]) { paintBatch(); paintPosts(); paintDigest(); paintHistory(); paintDiag(); }
  if (changes[K.DIGESTS]) { paintDigest(); paintHistory(); paintDiag(); }
  if (changes[K.AUTHORS]) { paintAuthors(); }
});
