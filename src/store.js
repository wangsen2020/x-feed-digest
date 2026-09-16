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
};

export const DEFAULT_SETTINGS = {
  enabled: true,
  hour: 9,            // 每日运行时刻（本地时间）
  minute: 0,
  windowHours: 24,    // 取最近多少小时的帖子
  perAuthor: 40,      // 兜底值；实际条数由 cadence.js 的档位决定
  maxToLLM: 80,       // 送进模型的条数上限
  minLikes: 0,        // 低于这个赞数直接丢
  dropRetweets: true,
  dropReplies: true,
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
