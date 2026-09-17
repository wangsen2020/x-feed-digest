/*! chrome.storage.local 的薄封装，集中定义 key 和默认值 */

export const K = {
  TEMPLATES: 'templates',   // { [op]: { queryId, features, fieldToggles, headers, origin, at } }
  AUTHORS:   'authors',     // [{ handle, userId, enabled }]
  SETTINGS:  'settings',
  HEALTH:    'health',      // { state, reason, at, failStreak }
  BATCH:     'batch',       // 当前批次（只留一个，见 README「批次与断点续传」）
  DIGESTS:   'digests',     // Grok 结论历史，跟批次解耦，单独保留
  POOL:      'pool',        // 被动囤积的推文 { [id]: tweet }
  REPORTED:  'reported',    // 已经出现在汇总里的推文 id，避免跨轮重复
  ME:        'me',          // { id, handle }
  RUNLOG:    'runlog',      // 定时执行日志（环形，见 background.js 的 logRun）
  LASTRUN:   'lastRun',     // 上一次定时汇总真正跑起来的时刻，用来补跑
};

export const DEFAULT_SETTINGS = {
  enabled: true,
  hour: 9,            // 每日运行时刻（本地时间）
  minute: 0,
  // 测试用：>0 时改成「每 N 分钟跑一次」，忽略上面的时刻。
  // 平时留 0。Chrome 对周期闹钟的下限是 30 秒，这里再收紧到 1 分钟。
  everyMinutes: 0,
  windowHours: 24,    // 取最近多少小时的帖子
  perAuthor: 40,      // 兜底值；实际条数由 cadence.js 的档位决定
  maxToLLM: 80,       // 送进模型的条数上限
  /*
   * 低于这个赞数直接丢。
   *
   * 不是 0，是因为比率和绝对值各偏一头：比率偏袒小号（102 粉 1 个赞就是 0.98%，
   * 排全场第一，而那条只有 1 次阅读），绝对值偏袒大号。两头都得堵一点。
   *
   * 5 是拿真实一轮量出来的：21 条候选里正好清掉 1 赞的空号和 3 赞的邀请码刷屏，
   * 剩 16 条；再往上到 20，lijigang 和 14.4w 粉的号全回来了——绝对数高的本来就是
   * 大号，与「过滤大 V」直接相冲。
   *
   * 池子太薄别靠拧这个数解决，把 windowHours 开大更管用。
   */
  minLikes: 5,
  dropRetweets: true,
  dropReplies: true,
  /*
   * 纯文字（没图、没视频、没引用）且很短的帖子直接丢，不送进 Grok。
   * 这类是「说说」：它的赞来自「谁说的」，新号复刻必然零互动。
   *
   * 卡的是「纯文字 **且** 短」，不是所有纯文字——清单、对比、步骤、观点框架
   * 这些最值得二创的东西本来就常常是纯文字长帖，一刀切会把最有价值的一类一起杀掉。
   * 想彻底不要纯文字，把 plainMinChars 调到很大（比如 99999）即可。
   */
  dropPlainShort: true,
  // 80 是量出来的，不是拍的：典型「说说」（两句话感慨）去掉空白约 36 字，
  // 典型清单帖（7 条要点 + 一句收尾）约 115 字。中文密度高，140 会把后者一起杀掉。
  plainMinChars: 80,    // 纯文字帖至少要这么多字（不算链接）才留下

  /*
   * 名人 / 大 V 过滤。
   *
   * maxFollowers 是这件事唯一靠谱的手段——直接按人头砍。
   *
   * 本来还想用「互动/粉丝低于 X% 就丢」来抓名人效应，拿真实的一轮（40 条）量过，
   * 这条路不成立，记下来免得以后又绕回去：
   *
   *   - 真实的互动/粉丝普遍在 0.0x% ~ 0.5%，全场最高 0.61%。
   *     「50w 粉拿 3000 赞 = 0.6% 是常态」这个直觉是错的，0.6% 已经是天花板。
   *   - 小号那头全是噪声：102 粉 1 个赞就是 0.98%，排全场第一，而那条帖子
   *     只有 1 次阅读。
   *   - 换成互动/阅读也一样不分好坏：莫迪 1.81% 排在李继刚 1.18% 前面。
   *     名人的帖子每次曝光的互动并不差——「围观」本身就是互动。
   *
   * 所以 minEngageRate 默认关（0）。留着这个旋钮是因为换一批博主它也许有意义，
   * 但别指望它替你区分名人和内容——填之前先看上面那组数。
   *
   * 粉丝数取不到（标「未知」）的不套用这两条：分母都没有，卡了等于瞎杀。
   */
  minEngageRate: 0,       // 互动/粉丝 低于这个百分比就丢；0 = 不卡（默认关，见上）
  maxFollowers: 200000,   // 粉丝超过这个数的作者整体不要；0 = 不限
  delayMs: [2000, 5000], // 博主之间的随机间隔，别把请求打成脉冲
  autoGrok: true,     // 定时汇总跑完后自动让 Grok 分析（手动汇总不会，见 README）
  maxToGrok: 40,      // 送进 Grok 的帖子条数上限，太多它会抓不住重点
  llm: { provider: 'none', apiKey: '', model: '', endpoint: '' },
};

export async function get(key, fallback) {
  const o = await chrome.storage.local.get(key);
  return o[key] === undefined ? fallback : o[key];
}

export async function set(key, val) {
  await chrome.storage.local.set({ [key]: val });
}

export async function getSettings() {
  const s = await get(K.SETTINGS, {});
  return { ...DEFAULT_SETTINGS, ...s, llm: { ...DEFAULT_SETTINGS.llm, ...(s.llm || {}) } };
}

export async function patch(key, obj) {
  const cur = await get(key, {});
  const next = { ...cur, ...obj };
  await set(key, next);
  return next;
}
