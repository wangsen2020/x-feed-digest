/*!
 * 复用 x.com 自带的 Grok（免费，不需要任何 API key）
 *
 * 实测结论决定了这个实现方式：
 *
 * - 直接伪造 `add_response.json` 请求**走不通**。grok.x.com / x.com/i/api /
 *   api.x.com 三个路径全部返回 404 code 34，缺的是 `x-client-transaction-id`——
 *   那个值是 X 前端每条请求现算的，伪造不了。
 *   （对比：GraphQL 的 GET 端点不需要它，所以抓帖子那条路能直接重放。）
 *
 * - 但驱动 Grok 自己的输入框可以。用 native setter 绕过 React 受控组件写入
 *   textarea，再点 aria-label="Grok something" 的按钮，X 自己的代码会把请求
 *   发出去，transaction-id 由它自己算。实测两条 prompt 都正常拿到了回答。
 *
 * - 答案不从 DOM 读，而是由 net-hook 在 document_start 截 add_response.json
 *   的响应流。这样后台窗口渲染被挂起也不影响——我们不依赖任何渲染结果。
 *
 * - **必须切到 Expert（专家）模式再发。** 默认的 Auto 会自己挑 Fast，而 Fast 挡不住
 *   这个任务：prompt 里白纸黑字写着「纯心情、一句话感慨直接淘汰」，Fast 照样把
 *   两句话的帖子推上来，理由还是编的。模式切换器是个 aria-label 等于当前模式名的
 *   按钮（Auto / Fast / Expert），点开是 role=menu，选完按钮的 aria-label 会跟着变——
 *   这就是「到底切没切成」的确认信号，不用猜。（实测这个选择是持久的，但不能依赖，
 *   每次发之前都确认一遍。）
 */

import { XApiError } from './xapi.js';

const GROK_URL = 'https://x.com/i/grok';

// 等待 net-hook 送回答案的挂起请求
let pending = null;

/** background 收到 bridge 转来的 grokAnswer 时调这个 */
export function deliverAnswer(text, raw) {
  if (!pending) return;
  const p = pending;
  pending = null;
  if (text && text.trim()) p.resolve(text);
  else p.reject(new XApiError('net', 0, 'Grok 返回了空回答' + (raw ? '（' + raw.slice(0, 120) + '）' : '')));
}

/** 取消等待中的 Grok 请求（用户点了取消） */
export function abort(reason) {
  if (!pending) return;
  const p = pending;
  pending = null;
  p.reject(new XApiError('cancelled', 0, reason || '已取消'));
}

/**
 * 注入页面的驱动脚本（MAIN world）。必须自包含——不能引用外部作用域。
 *
 * 返回 Promise，executeScript 会等它 resolve。
 *
 * 这里每一步都要确认，不能想当然：
 * 之前是「设值 → setTimeout 300ms → 点按钮」，在最小化窗口里定时器被钳制、
 * React 还没提交重渲染，点到的是仍然禁用的按钮——什么都不会发生，
 * 然后外面干等到超时，报出来的却是「Grok 超时未返回」，完全误导。
 */
function drive(prompt) {
  return (async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const findBtn = () => Array.prototype.find.call(
      document.querySelectorAll('button'),
      (b) => b.getAttribute('aria-label') === 'Grok something'
    );
    const ready = (b) => b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';

    /*
     * 输入框必须锚在 X 自己的 React 根里找，不能用 document.querySelector('textarea')。
     * 页面上别的扩展会往 <body> 上直接挂 textarea（实测过一个筛选面板挂了 3 个 0×0 的，
     * 外加一个裸 textarea）。这些在 load 时刻就已经在 DOM 里了，而 Grok 的输入框要等
     * React 挂载，实测晚约 900ms —— 中间这段窗口里「第一个 textarea」是别人的。
     * 选错了不会报错：prompt 被塞进那个隐藏框，真输入框始终是空的，
     * 于是「Grok something」永远不出现，最后报成「发送按钮始终不可用」，完全误导。
     * 用「在 #react-root 内 + 真的渲染出来了」两条来认，不依赖语言和 class 名。
     */
    const findTa = () => {
      const root = document.getElementById('react-root');
      if (!root) return null;
      return Array.prototype.find.call(
        document.querySelectorAll('textarea'),
        (t) => root.contains(t) && t.offsetParent !== null && t.getBoundingClientRect().width > 100
      ) || null;
    };

    /*
     * 模式切换器。按 aria-label 认：它等于当前模式名。
     * 中英文都列上——同一个账号换个语言设置就全对不上了。
     */
    const MODES = ['Auto', 'Fast', 'Expert', '自动', '快速', '专家'];
    const EXPERT = ['Expert', '专家'];
    const modeBtn = () => Array.prototype.find.call(
      document.querySelectorAll('button'),
      (b) => MODES.indexOf((b.getAttribute('aria-label') || '').trim()) >= 0
    );
    const curMode = () => {
      const b = modeBtn();
      return b ? (b.getAttribute('aria-label') || '').trim() : '';
    };
    const isExpert = () => EXPERT.indexOf(curMode()) >= 0;

    async function ensureExpert() {
      let b = null;
      for (let i = 0; i < 20 && !b; i++) { b = modeBtn(); if (!b) await sleep(300); }
      if (!b) return { mode: '', err: '没找到模式切换按钮' };
      if (isExpert()) return { mode: curMode() };

      b.click();
      let item = null;
      for (let i = 0; i < 20 && !item; i++) {
        await sleep(200);
        const m = document.querySelector('[role=menu]');
        if (!m) continue;
        item = Array.prototype.find.call(
          m.querySelectorAll('[role=menuitem]'),
          // 每一项是「Expert」+「Thinks hard · Grok 4.6」两行，只认第一行
          (n) => EXPERT.indexOf(((n.innerText || '').split(String.fromCharCode(10))[0] || '').trim()) >= 0
        );
      }
      if (!item) {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
        return { mode: curMode(), err: '模式菜单里没有「专家」这一项' };
      }
      item.click();
      for (let i = 0; i < 20; i++) {
        await sleep(200);
        if (isExpert()) return { mode: curMode() };
      }
      return { mode: curMode(), err: '点了「专家」但按钮还显示「' + (curMode() || '空') + '」' };
    }

    // 1. 等输入框挂载。后台窗口渲染被挂起，SPA 首次挂载可能比 load 事件晚不少。
    let el = null;
    for (let i = 0; i < 40 && !el; i++) {
      el = findTa();
      if (!el) await sleep(500);
    }
    if (!el) return { ok: false, err: 'Grok 输入框一直没出现（页面可能没加载完）' };

    /*
     * 1.5 切专家模式。必须放在写 prompt **之前**：切换会让 React 重渲染，
     * 先写好的内容可能被清掉。切完重新找一次输入框（旧引用可能已经被换掉了）。
     */
    const m = await ensureExpert();
    if (m.err) return { ok: false, modeErr: m.err, mode: m.mode, err: '没能切到专家模式：' + m.err };
    el = findTa() || el;

    // 2. React 受控组件：直接改 .value 不触发 onChange，必须走原型上的 setter
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, prompt);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    // 落地确认：受控组件有可能把值吃掉，这时候后面全是白等
    if (el.value !== prompt) {
      return { ok: false, err: '输入框没收下 prompt（收到 ' + el.value.length + ' / ' + prompt.length + ' 字）' };
    }

    /*
     * 3. 提交。
     *
     * 别再把「点到那个按钮」当成唯一出路。实测出现过这样一次：prompt 已经完整落进
     * 输入框（长度校验过），但 aria-label='Grok something' 的按钮 112 秒里一次都没
     * 出现过，于是干等到超时。为什么没出现还没查清——在正常窗口、后台隐藏标签页、
     * 两万字超长 prompt、以及已有会话的页面上都复现不出来。
     *
     * 但人发消息本来就是敲回车，不必非等那个按钮。所以：能点到按钮就点，点不到就
     * 回车，两条路都走不通才算失败。真伪不看按钮，由第 4 步统一判定。
     */
    const t0 = Date.now();
    let btn = null;
    for (let i = 0; i < 24; i++) {
      btn = findBtn();
      if (ready(btn)) break;
      await sleep(250);
    }
    const sawBtn = !!btn;

    let how;
    if (ready(btn)) {
      btn.click();
      how = 'click';
    } else {
      el.focus();
      const key = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      for (const type of ['keydown', 'keypress', 'keyup']) {
        el.dispatchEvent(new KeyboardEvent(type, key));
      }
      how = btn ? 'enter(按钮禁用)' : 'enter(无按钮)';
    }

    /*
     * 4. 确认真的提交了：发送后输入框会清空，「Grok something」按钮也会消失
     *    （换成 Regenerate / Copy text）。
     *
     * 「按钮消失」只有在提交前确实见过它才算数——否则在「按钮压根没出现」那个
     * 故障场景里，这一条第一轮就成立，会把彻底没发出去的情况谎报成成功。
     */
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      const ta = findTa();
      if (!ta || ta.value === '') return { ok: true, waited: Date.now() - t0, how, mode: m.mode, modeErr: m.err };
      if (sawBtn && !findBtn()) return { ok: true, waited: Date.now() - t0, how, mode: m.mode, modeErr: m.err };
    }

    /*
     * 还是没出去。把现场带回来——光说「没提交成功」查不动。
     * 重点是「选中的到底是哪个输入框」：页面上别的扩展往 body 上挂 textarea 的事
     * 已经踩过一次，这里把所有候选的尺寸和 placeholder 都列出来，一眼就能分辨。
     */
    const labels = Array.prototype.map.call(document.querySelectorAll('button'),
      (b) => b.getAttribute('aria-label')).filter(Boolean);
    const root = document.getElementById('react-root');
    const tas = Array.prototype.map.call(document.querySelectorAll('textarea'), (t) => {
      const r = t.getBoundingClientRect();
      const outside = !(root && root.contains(t));
      return (t === el ? '*' : '') + '[' + (t.placeholder || '无').slice(0, 12) + ' '
        + Math.round(r.width) + 'x' + Math.round(r.height) + (outside ? ' 站外' : '') + ']';
    });
    return { ok: false, err: '提交没生效（' + how + '，等了 '
      + Math.round((Date.now() - t0) / 1000) + ' 秒，输入框仍有 '
      + (findTa() ? findTa().value.length : 0) + ' 字）'
      + '；窗口 ' + window.innerWidth + 'x' + window.innerHeight
      + '，可见性 ' + document.visibilityState
      + '；输入框 ' + tas.join(' ')
      + '；按钮 ' + labels.slice(0, 14).join(' / ')
      + '；模式 ' + (m.mode || '未知') + (m.err ? '（' + m.err + '）' : '') };
  })();
}

/**
 * 注入页面读取答案（MAIN world）。
 *
 * 不依赖任何 class 名或 data-testid——Grok 页面上这些随时会变。
 * 改用「prompt 锚定」：页面全文里我们发出去的那句话之后的部分就是回答。
 * 实测在真实会话页上提取得很干净。
 */
function readAnswer(anchor) {
  // 完成信号：生成完毕才会出现 Regenerate / Copy text / Share，生成期间一个都没有。
  // 这比「文本连续两轮不变」可靠得多——思考阶段页面上那句
  // 「Thinking about your request」能稳定好几秒不变，会被误判成写完了。
  const labels = Array.prototype.map.call(
    document.querySelectorAll('button'), (b) => b.getAttribute('aria-label')
  );
  const done = labels.indexOf('Regenerate') >= 0 || labels.indexOf('Copy text') >= 0;

  const root = document.querySelector('[data-testid=primaryColumn]') || document.body;
  const t = root.innerText || '';

  /*
   * Grok 自己翻车的状态（实测见过）：页面上出现
   *   「Grok was unable to reply. Something went wrong, please refresh to
   *     reconnect or try again.」+ 一个 Retry 按钮
   *
   * 这时候 Regenerate / Copy text **一个都不会出现**，所以上面那个完成信号永远
   * 等不到。不认它的话，外面会一路干等到超时，然后报「已确认发送成功，但 360 秒内
   * 没等到 Grok 写完」——听起来像是慢，其实是早就死了，完全误导。
   */
  const FAIL = /Grok was unable to reply|Something went wrong, please refresh/;
  const i = t.lastIndexOf(anchor);
  if (i < 0) return { text: '', done: false };

  /*
   * 报错必须出现在**我们这条 prompt 之后**才算数。
   *
   * 实测踩过：上一轮留在页面上的错误横幅不会自己消失，只看「页面上有没有这句话」
   * 会把刚发出去的请求当场判死——错误是上一次的。锚点之后才是这一轮的地盘。
   */
  if (FAIL.test(t.slice(i))) return { text: '', done: false, failed: true };

  // 页面上混着控件文案和思考期占位符，按行剔掉。
  // 「Thinking about your request」是逐字打出来的，所以要按前缀匹配。
  const THINKING = 'Thinking about your request';
  // 模式名会被 innerText 一起读进来。X 改过一版：Quick Answer / Think Harder
  // 现在叫 Fast / Expert，旧的一并留着，改回去也不用动代码。
  const JUNK = ['Quick Answer', 'Auto', 'Think Harder', 'Fast', 'Expert',
                '自动', '快速', '专家', 'Go to grok.com',
                'Regenerate', 'Copy text',
                'Share', 'New Chat', 'See new posts', 'Stop', 'Thought for a moment'];
  const text = t.slice(i + anchor.length).split(String.fromCharCode(10))
    .filter((line) => {
      const l = line.trim();
      if (!l) return true;
      if (JUNK.indexOf(l) >= 0) return false;
      if (THINKING.indexOf(l) === 0) return false;   // 含逐字打字的中间态
      return true;
    })
    .join(String.fromCharCode(10)).trim();

  return { text, done };
}

/**
 * 点掉「Grok was unable to reply」旁边那颗 Retry（注入页面，MAIN world）。
 * 按钮上没有 aria-label 也没有 testid，只能认那个文字是 Retry 的叶子节点，
 * 再往上爬到真正可点的 button。
 */
function clickRetry() {
  const leaf = Array.prototype.find.call(
    document.querySelectorAll('span,div,button'),
    (e) => e.children.length === 0 && (e.innerText || '').trim() === 'Retry'
  );
  if (!leaf) return false;
  let n = leaf;
  for (let i = 0; i < 6 && n; i++) {
    if (n.tagName === 'BUTTON' || n.getAttribute('role') === 'button') break;
    n = n.parentElement;
  }
  (n || leaf).click();
  return true;
}

/**
 * 问 Grok 一个问题，返回它的回答。
 * @param {number} tabId    已经停在 Grok 页面上的标签页
 * @param {string} prompt
 * @param {number} timeoutMs
 */
export async function ask(tabId, prompt, timeoutMs) {
  if (pending) throw new XApiError('net', 0, '已有一个 Grok 请求在等待');

  /*
   * 实测：40 条帖子的 prompt，Fast 模式约 41 秒生成完 2000 字。
   * 专家模式要先想一轮，慢得多——21 条帖子、6220 字的 prompt 实测**约 5 分钟**
   * 才写完 5600 字。再加上可能要自己点一次 Retry 重来，360s 完全不够，给到 10 分钟。
   * 反正有 60 秒静默看门狗兜着，跑不满也不会真等这么久。
   */
  const limit = timeoutMs || 600000;
  const t0 = Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 通道一：net-hook 截 add_response.json 的响应流
  let streamText = null, aborted = null;
  const streamP = new Promise((resolve, reject) => { pending = { resolve, reject }; });
  streamP.then((t) => { streamText = t; }, (e) => { aborted = e; });

  // 先把 prompt 发出去，每一步都确认
  let res;
  try {
    res = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN', func: drive, args: [prompt],
    });
  } catch (e) {
    pending = null;
    throw new XApiError('net', 0, '注入 Grok 页面失败：' + (e && e.message));
  }
  const r = res && res[0] && res[0].result;
  if (!r || !r.ok) {
    pending = null;
    /*
     * 切不到专家模式就不发。Fast 模式的结论质量撑不住这个任务（实测它会把
     * 两句话的心情帖推上来，而 prompt 里明写了这类直接淘汰），与其产出一份
     * 你得逐条读完再全部丢掉的东西，不如当场报错——分析随时可以对着同一批
     * 帖子重跑，不用重新抓。
     */
    throw new XApiError('net', 0, (r && r.err) || 'Grok 页面无响应');
  }

  /*
   * 通道二：轮询页面 DOM。
   *
   * 为什么要两条通道：上一版只靠流截取，结果出现过「会话建好了、Grok 也答了，
   * 扩展却报超时」——答案明明在页面上。流截取依赖 net-hook 在 document_start
   * 抢在 X 的 bundle 之前打上补丁，这个前提在某些时序下会不成立。
   *
   * 轮询还顺带解决了另一个隐患：MV3 的 service worker 空闲 30 秒就会被回收，
   * 而这里要等 40 秒以上。每 3 秒调一次 chrome.scripting 会重置那个空闲计时器，
   * worker 就不会在等待中途被杀掉。
   */
  const anchor = prompt.split(String.fromCharCode(10)).filter((l) => l.trim()).pop();
  const deadline = Date.now() + limit;
  let last = '', stable = 0, sawAny = false, retried = false;

  while (Date.now() < deadline) {
    if (streamText) { pending = null; return { text: streamText, ms: Date.now() - t0, via: 'stream', mode: r.mode }; }
    if (aborted) { pending = null; throw aborted; }

    await sleep(3000);

    let cur = '', done = false;
    try {
      const out = await chrome.scripting.executeScript({
        target: { tabId }, world: 'MAIN', func: readAnswer, args: [anchor],
      });
      const rr = (out && out[0] && out[0].result) || {};
      cur = rr.text || '';
      done = !!rr.done;
      /*
       * Grok 自己翻车了。实测长 prompt（6000+ 字）在专家模式下失败率不低——
       * 同一份内容连着两次 unable to reply，第三次新开会话就正常跑完了。
       * 所以先自己点一次 Retry 再说，别把一轮抓取的成果浪费在一次抽风上。
       * 重试也失败才往上报。
       */
      if (rr.failed) {
        if (retried) {
          pending = null;
          throw new XApiError('net', 0, 'Grok 连着两次报错（页面上是 "unable to reply"）。'
            + '这是 X 那边的偶发故障，不是帖子或 prompt 的问题，过一会重跑分析即可。');
        }
        retried = true;
        await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: clickRetry });
        last = ''; stable = 0;
        continue;
      }
    } catch (e) {
      if (e instanceof XApiError) throw e;   // 上面那条是真失败，别被当成「跳转中」吞掉
      /* 标签页可能正在跳转，下一轮再试 */
    }

    if (cur) sawAny = true;

    // 正解：等 Grok 自己说写完了（Regenerate / Copy text 出现）
    if (done && cur) { pending = null; return { text: cur, ms: Date.now() - t0, via: 'dom', mode: r.mode }; }

    /*
     * 兜底：万一 X 改了那几个按钮的 aria-label，完成信号就没了，
     * 这时才退回文本稳定性判断——但要求严得多：
     * 连续 5 轮（15 秒）不变，而且至少 200 字。
     * 思考阶段那句占位文案只有二三十字，进不来。
     */
    if (cur && cur === last && cur.length >= 200) {
      if (++stable >= 5) { pending = null; return { text: cur, ms: Date.now() - t0, via: 'dom-stable', mode: r.mode }; }
    } else {
      stable = 0;
      last = cur;
    }
  }

  pending = null;
  throw new XApiError('net', 0,
    '已确认发送成功，但 ' + Math.round(limit / 1000) + ' 秒内没等到 Grok 写完'
    + (sawAny ? '（页面上只读到 ' + last.length + ' 字）' : '（页面上什么都没读到）'));
}




export { GROK_URL };

/**
 * 序号 → 原帖的映射。
 * Grok 的回答以「31 @handle ...」开头，这个 31 就是 prompt 里的序号，
 * 有了这张表就能把结论里的编号还原成可点的原帖链接。
 */
export function buildIndex(posts, limit) {
  return posts.slice(0, limit || 40).map((t, i) => ({
    n: i + 1, id: t.id, url: t.url, handle: t.author.handle,
  }));
}

/** 把帖子列表拼成给 Grok 的 prompt。序号必须和 buildIndex 一致。 */
export function buildPrompt(posts, limit) {
  const fmt = (n) => (n >= 10000 ? (n / 10000).toFixed(1) + 'w'
    : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n || 0));

  /*
   * 互动率**由我们算好再写进去**，不要求模型自己算。
   *
   * 上一版把粉丝数和互动数并排给它，再在要求里写「判断前先自己算一遍互动除以
   * 粉丝数」——实测它就是不算。一个 5.4w 粉的号发两句话，照样被推上来当成
   * 「值得二创」。让模型一边读 40 条帖子一边心算 40 次除法，本来就不是个
   * 合理的指望；这道除法我们这边一行代码的事。
   *
   * 形态（纯文字 / 图 / 视频 / 引用）也一并标出来：新号能不能复刻，很大程度上
   * 取决于原帖是靠什么成立的。
   */
  /*
   * 两个比值一起给。
   *
   * 互动/粉丝 说明「他自己的受众里有多少人真的动了手」；
   * 阅读/粉丝 说明「这条有没有被推到他的受众之外」——实测这个更能区分
   * 「内容在跑」和「粉丝在捧场」：同一批数据里，一条 40% 的帖子确实是传开了，
   * 而 1.07 亿粉的账号再火也只有 0%。
   *
   * 小数位按量级给：互动/粉丝普遍是 0.0x%，保留一位等于全是 0.0，看不出差别。
   */
  const rate = (t) => {
    const m = t.metrics;
    const e = m.like + m.rt + m.quote + m.reply;
    const f = t.author.followers;
    if (f > 0) {
      return '互动/粉丝 ' + (e / f * 100).toFixed(2) + '%'
        + (m.views > 0 ? ' · 阅读/粉丝 ' + (m.views / f * 100).toFixed(0) + '%' : '');
    }
    if (m.views > 0) return '互动/阅读 ' + (e / m.views * 100).toFixed(1) + '%（粉丝数未知）';
    return '互动率未知';
  };

  const form = (t) => {
    const ms = t.media || [];
    const kinds = [];
    if (ms.some((x) => x.type === 'video' || x.type === 'animated_gif')) kinds.push('视频');
    if (ms.some((x) => x.type === 'photo')) kinds.push('图');
    if (t.isQuote) kinds.push('引用');
    return kinds.length ? kinds.join('+') : '纯文字';
  };

  const list = posts.slice(0, limit || 40).map((t, i) => {
    const m = t.metrics;
    const text = (t.text || '').replace(/\s+/g, ' ').slice(0, 280);
    const f = t.author.followers;
    return (i + 1) + '. @' + t.author.handle
      + '（粉丝 ' + (f > 0 ? fmt(f) : '未知')
      + ' · 赞 ' + fmt(m.like) + ' 转 ' + fmt(m.rt) + ' 引 ' + fmt(m.quote) + ' 评 ' + fmt(m.reply)
      + (m.views > 0 ? ' · 阅读 ' + fmt(m.views) : '')
      + ' · ' + rate(t)
      + ' · ' + form(t)
      + '）：' + text;
  }).join(String.fromCharCode(10));

  return [
    '下面是我关注的博主最近发的帖子，每条都带了作者的粉丝数和这条的互动数据。',
    '',
    list,
    '',
    '我的处境：我是一个粉丝很少的新号，没有名气背书，没有圈内人脉，没有可展示的战绩。',
    '我能做的只有三件事：转发并加上自己的评论、二次创作（换角度重写、做成清单或对比）、',
    '或者就同一个选题自己发一条。',
    '',
    '请挑出 10 条「我拿来转发或二创也能吃到流量」的帖子，按可行性从高到低排序。',
    '',
    '第一原则：这条帖子的流量，是内容本身挣来的，还是作者的身份和粉丝基数带来的？',
    '只要后者占主导，数据再好看也不要。',
    '每条我都已经算好了「互动/粉丝」和「阅读/粉丝」，直接看这两个数，不要看赞数的绝对值。',
    '注意真实量级：互动/粉丝普遍在 0.0x% 到 0.5% 之间，0.5% 已经很高了，别拿 1% 当及格线。',
    '同一个数量级里比就行：一条 0.4% 的帖子明显强过同批 0.02% 的。',
    '「阅读/粉丝」超过 20% 说明这条被推到了作者自己的受众之外，是内容在跑，不是粉丝在捧场。',
    '粉丝很少的号（几百粉）互动率会虚高——3 个赞就能算出很高的百分比，',
    '这种要看绝对互动数和阅读量够不够，别被比例骗了。',
    '',
    '这几类直接淘汰，无论数据多好看：',
    '- 纯心情、一句话感慨、日常碎碎念：它的赞来自「谁说的」，不是「说了什么」，我复刻只会零互动',
    '- 标着「纯文字」而且内容上没有可复用结构的：作者的名气就是它全部的流量来源',
    '- 圈内梗、需要长期关注该作者才看得懂的上下文',
    '- 靠作者身份才成立的内容（我刚融了多少钱、我团队如何、我的产品数据如何）：这种话我说不了',
    '- 蹭突发热点的强时效帖：等我二创完热度已经过去了',
    '- 单纯搬运转述、本身没有增量观点的',
    '',
    '优先选这几类：',
    '- 有可复用结构的：清单、对比、步骤、常见误区、数据拆解、观点框架——换个领域就能重做一遍',
    '- 选题本身有争议或有讨论空间的：看回复数相对于点赞数是否偏高，评论区热说明话题能接得住',
    '- 转发和引用占比高的：说明它已经跑到作者自己的受众之外，是内容在传播，不是粉丝在捧场',
    '- 讲通用问题的：方法、认知、工具、行业常识——不依赖作者是谁',
    '',
    '每条输出四行，第一行必须以「序号 @作者」开头，序号用上面列表里的原始编号：',
    '  编号 + @作者 + 一句话概括这条讲了什么',
    '  凭什么说流量是内容挣的：给出具体的倍率或占比数字，指明它不是靠粉丝基数',
    '  我可以怎么发：给我一条 140 字以内、中文、可直接发布的正文，要和原帖角度有差异，',
    '    不要复述原作者说过的话，也不要出现只有他本人才能说的话',
    '  预期效果：这条发出去可能吸引什么样的人关注我',
    '',
    '',
    '「凭什么说流量是内容挣的」这一行是一道闸，不是说明文字：',
    '如果你在这一行里写出的是「大号稀释明显」「流量仍偏作者名气」「内容本身拉动有限」',
    '这类否定的话，说明这条根本没通过第一原则，**就不要把它列进来**。',
    '这一行只允许写支持它入选的证据；写不出来就是不够格。',
    '',
    '宁缺毋滥。够格的只有 3 条就只给 3 条，凑满 10 条对我没有任何价值——',
    '我要照着发的，多一条不够格的就是多浪费我一次发布机会。',
    '最后单独写一行：给了几条，砍掉了几条，砍掉的主要是因为什么。',
    '直接输出，不要复述我的要求，不要写开场白。',
  ].join(String.fromCharCode(10));
}
