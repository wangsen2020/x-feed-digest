import { K, get, set, getSettings } from './src/store.js';

const $ = (id) => document.getElementById(id);

// 模板没捕获时自动补，不用你点。后台有 10 分钟节流，不会反复开窗。
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
    if (r && r.ok) { $('msg').textContent = '接口参数已就绪'; }
    else if (r && (r.busy || r.cooling)) { /* 稍后会自己再来，不打扰 */ }
    else if (r && r.error) { $('msg').textContent = '自动准备失败：' + r.error; }
    paint();
  });
}

const REASON_SHORT = {
  auth:  '凭证已失效，需要重新捕获',
  stale: '接口版本已变更，需要重新捕获',
  rate:  '连续被限流',
  net:   '网络异常',
};

async function paint() {
  const health = await get(K.HEALTH, {});
  const batch = await get(K.BATCH, null);
  const templates = await get(K.TEMPLATES, {});
  const authors = await get(K.AUTHORS, []);

  const box = $('status');
  const needCapture = !(templates.UserOriginalsTimeline || templates.UserTweets) || !templates.UserByScreenName;

  // auth / stale 要你本人去刷 x.com；setup（没捕获过）能自愈，不该红着挂在这
  const mustAsk = health.needsAttention && health.state !== 'setup';

  if (mustAsk) {
    box.className = 'status warn';
    $('statusText').textContent = REASON_SHORT[health.state] || '运行异常';
    $('statusSub').textContent = health.reason || '';
  } else if (needCapture) {
    box.className = 'status info';
    $('statusText').textContent = '正在自动准备…';
    $('statusSub').textContent = '首次使用需要捕获一次接口参数，扩展自己会开后台页面完成';
    selfHeal();
  } else {
    box.className = 'status ok';
    $('statusText').textContent = '运行正常 · ' + authors.length + ' 个博主';
    if (batch) {
      const n = Object.keys(batch.posts || {}).length;
      const left = (batch.queue || []).length;
      $('statusSub').textContent = new Date(batch.updatedAt).toLocaleString()
        + ' · ' + n + ' 条'
        + (left ? ' · 剩 ' + left + ' 个博主未抓' : '');
    } else {
      $('statusSub').textContent = '尚未运行过';
    }
  }

  const s = await getSettings();
  $('enabled').checked = s.enabled;
  $('time').value = String(s.hour).padStart(2, '0') + ':' + String(s.minute).padStart(2, '0');
}

// 后台一次只跑一个任务；popup 跟着那个状态走，别让你点出并发来
function setBusy(job) {
  const on = !!job;
  for (const id of ['run', 'enabled', 'time']) {
    const el = $(id);
    if (el) el.disabled = on;
  }
  $('run').textContent = on ? (job.label || '处理中') + '…' : '立即汇总一次';
  if (on) $('msg').textContent = job.progress || '';
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.cmd === 'jobState') setBusy(msg.job);
});

// popup 每次打开都是新页面，后台可能正跑着（定时任务或你在面板里点的），先问一次
chrome.runtime.sendMessage({ cmd: 'jobStatus' }, (r) => {
  if (!chrome.runtime.lastError) setBusy(r && r.job);
});

$('run').addEventListener('click', () => {
  $('msg').textContent = '';
  chrome.runtime.sendMessage({ cmd: 'runNow' }, (r) => {
    if (chrome.runtime.lastError) { $('msg').textContent = chrome.runtime.lastError.message; setBusy(null); return; }
    if (!r) { $('msg').textContent = '后台无响应'; setBusy(null); return; }
    if (r.busy) { $('msg').textContent = r.error; return; }   // 被锁挡下，不是失败
    $('msg').textContent = r.cancelled
      ? '已暂停，剩 ' + r.remaining + ' 个，下次从断点继续'
      : r.ok
      ? '完成，' + r.count + ' 条' + (r.usedPool ? '（本地缓存）' : '')
      : '失败：' + (r.error || (r.failures && r.failures[0] && r.failures[0].msg) || '无数据');
    paint();
  });
});

$('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
// 这个按钮兼两个用途：能自愈时强制跑一次捕获，不能自愈时打开 x.com 让你自己刷
$('openX').addEventListener('click', async () => {
  const h = await get(K.HEALTH, {});
  if (h.needsAttention && h.state !== 'setup') { chrome.tabs.create({ url: 'https://x.com/home' }); return; }
  tried = false;   // 你主动点了，就放开自动尝试的闸
  $('msg').textContent = '正在捕获…';
  chrome.runtime.sendMessage({ cmd: 'bootstrap' }, (r) => {
    if (chrome.runtime.lastError) { $('msg').textContent = chrome.runtime.lastError.message; return; }
    $('msg').textContent = r && r.ok
      ? '已捕获：' + (r.captured || []).join('、')
      : '捕获失败：' + ((r && r.error) || '未知');
    paint();
  });
});

async function saveSchedule() {
  const [h, m] = $('time').value.split(':').map(Number);
  const s = await getSettings();
  await set(K.SETTINGS, { ...s, enabled: $('enabled').checked, hour: h || 0, minute: m || 0 });
  chrome.runtime.sendMessage({ cmd: 'reschedule' }, () => void chrome.runtime.lastError);
  $('msg').textContent = '已保存';
}
$('enabled').addEventListener('change', saveSchedule);
$('time').addEventListener('change', saveSchedule);

paint();
