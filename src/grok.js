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

    // 1. 等输入框挂载。后台窗口渲染被挂起，SPA 首次挂载可能比 load 事件晚不少。
    let el = null;
    for (let i = 0; i < 40 && !el; i++) {
      el = document.querySelector('textarea');
      if (!el) await sleep(500);
    }
    if (!el) return { ok: false, err: 'Grok 输入框一直没出现（页面可能没加载完）' };

    // 2. React 受控组件：直接改 .value 不触发 onChange，必须走原型上的 setter
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, prompt);
    el.dispatchEvent(new Event('input', { bubbles: true }));

    // 3. 等按钮真的可用，再点。提交按钮只有 aria-label，没有文本也没有 data-testid。
    let btn = null;
    for (let i = 0; i < 60; i++) {
      btn = findBtn();
      if (ready(btn)) break;
      await sleep(250);
    }
    if (!ready(btn)) return { ok: false, err: '等了 15 秒，发送按钮始终不可用' };
    btn.click();

    // 4. 确认真的提交了：发送后输入框会清空，「Grok something」按钮也会消失
    //    （换成 Regenerate / Copy text）。两个信号满足任一即可。
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      const ta = document.querySelector('textarea');
      if (!ta || ta.value === '' || !findBtn()) return { ok: true, waited: i * 250 };
    }
    return { ok: false, err: '点了发送但输入框没清空，可能没提交成功' };
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
  const i = t.lastIndexOf(anchor);
  if (i < 0) return { text: '', done: false };

  // 页面上混着控件文案和思考期占位符，按行剔掉。
  // 「Thinking about your request」是逐字打出来的，所以要按前缀匹配。
  const THINKING = 'Thinking about your request';
  const JUNK = ['Quick Answer', 'Auto', 'Think Harder', 'Regenerate', 'Copy text',
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
 * 问 Grok 一个问题，返回它的回答。
 * @param {number} tabId    已经停在 Grok 页面上的标签页
 * @param {string} prompt
 * @param {number} timeoutMs
 */
export async function ask(tabId, prompt, timeoutMs) {
  if (pending) throw new XApiError('net', 0, '已有一个 Grok 请求在等待');

  // 实测：40 条帖子的 prompt，Grok 约 41 秒生成完 2000 字。留足余量。
  const limit = timeoutMs || 180000;
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
  let last = '', stable = 0, sawAny = false;

  while (Date.now() < deadline) {
    if (streamText) { pending = null; return { text: streamText, ms: Date.now() - t0, via: 'stream' }; }
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
    } catch (e) { /* 标签页可能正在跳转，下一轮再试 */ }

    if (cur) sawAny = true;

    // 正解：等 Grok 自己说写完了（Regenerate / Copy text 出现）
    if (done && cur) { pending = null; return { text: cur, ms: Date.now() - t0, via: 'dom' }; }

    /*
     * 兜底：万一 X 改了那几个按钮的 aria-label，完成信号就没了，
     * 这时才退回文本稳定性判断——但要求严得多：
     * 连续 5 轮（15 秒）不变，而且至少 200 字。
     * 思考阶段那句占位文案只有二三十字，进不来。
     */
    if (cur && cur === last && cur.length >= 200) {
      if (++stable >= 5) { pending = null; return { text: cur, ms: Date.now() - t0, via: 'dom-stable' }; }
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
  const list = posts.slice(0, limit || 40).map((t, i) => {
    const m = t.metrics;
    const text = (t.text || '').replace(/\s+/g, ' ').slice(0, 280);
    return (i + 1) + '. @' + t.author.handle + '（赞 ' + m.like + ' 转 ' + m.rt + '）：' + text;
  }).join('\n');

  return [
    '下面是我关注的博主最近发的帖子，每条都标了互动数据。',
    '',
    list,
    '',
    '请从中挑出 10 条「最值得我借鉴来涨粉」的帖子，按潜力从高到低排序。',
    '每条输出四行，第一行必须以「序号 @作者」开头，序号用上面列表里的原始编号：',
    '  编号 + @作者 + 一句话概括这条讲了什么',
    '  值得借鉴的点：它为什么能拿到这些互动（选题？角度？表达方式？时机？）',
    '  我可以怎么发：给我一条 140 字以内、中文、可直接发布的正文，要和原帖角度有差异，',
    '    不要复述原作者说过的话',
    '  预期效果：这条发出去可能吸引什么样的人关注我',
    '',
    '挑选标准：互动数据高只是参考，更要看这个选题是否可延展、是否有讨论空间、',
    '是否适合一个还在涨粉阶段的账号切入。纯粹的个人动态、圈内玩梗、需要大量前置',
    '背景才能看懂的内容，不要选。',
    '',
    '直接输出这 10 条，不要复述我的要求，不要写开场白。',
  ].join('\n');
}

