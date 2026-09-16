/*!
 * 按更新频率给博主分档
 *
 * 高频博主每天抓、抓得多；低频博主隔几天抓一次、但把时间窗拉长，
 * 这样既不漏帖，也不会为了一个一周发一条的人天天发请求。
 *
 * 判断依据是每次抓取实际看到的发帖密度，用 EWMA 平滑，
 * 避免某天爆发或某天沉默就把档位甩来甩去。
 */

export const TIERS = {
  hot:    { label: '高频', minRate: 3.0,  everyDays: 1, count: 60 },
  warm:   { label: '常规', minRate: 0.5,  everyDays: 1, count: 30 },
  cold:   { label: '低频', minRate: 0.1,  everyDays: 3, count: 30 },
  frozen: { label: '沉寂', minRate: 0,    everyDays: 7, count: 40 },
};

const ORDER = ['hot', 'warm', 'cold', 'frozen'];
const DAY = 24 * 3600 * 1000;

export function tierOf(rate) {
  for (const k of ORDER) if ((rate || 0) >= TIERS[k].minRate) return k;
  return 'frozen';
}

/** 这个博主这一轮该不该抓 */
export function isDue(a, now) {
  if (!a.nextDueAt) return true;
  return now >= a.nextDueAt;
}

/** 这一轮给它抓多少条 */
export function countFor(a) {
  return TIERS[a.tier || 'warm'].count;
}

/**
 * 每个博主的回看窗口：至少是全局设置的窗口，
 * 但如果上次抓它已经是好几天前（低频档会跳过若干天），
 * 就把窗口拉到覆盖这段空档，免得漏掉它在空档期发的帖。
 */
export function lookbackSince(a, now, settingsWindowHours) {
  const base = now - settingsWindowHours * 3600 * 1000;
  if (!a.lastFetchAt) return base;
  return Math.min(base, a.lastFetchAt - 3600 * 1000); // 多留 1 小时重叠，边界上别漏
}

/**
 * 抓完之后更新这个博主的节奏画像。
 * @param {object} a       博主记录（原地修改）
 * @param {array}  tweets  这次抓到的、确认属于这个博主的原创帖
 * @param {number} now
 */
export function updateCadence(a, tweets, now) {
  // 用这批帖子自身的时间跨度算密度，比“除以固定天数”准：
  // 抓 60 条可能覆盖 2 天（高频）也可能覆盖 60 天（低频）。
  let rate = 0;
  if (tweets.length >= 2) {
    const ts = tweets.map((t) => t.createdAt).filter(Boolean).sort((x, y) => x - y);
    const spanDays = Math.max((ts[ts.length - 1] - ts[0]) / DAY, 0.5);
    rate = tweets.length / spanDays;
  } else if (tweets.length === 1) {
    rate = 0.5;
  } else {
    rate = 0;   // 这次一条都没有，往下压
  }

  // EWMA，新样本占 40%，老画像占 60%
  a.rate = a.rate === undefined ? rate : a.rate * 0.6 + rate * 0.4;
  a.tier = tierOf(a.rate);
  a.lastFetchAt = now;
  a.nextDueAt = now + TIERS[a.tier].everyDays * DAY - 30 * 60 * 1000; // 留半小时余量，免得卡在边界上整天跳过
  if (tweets.length) a.lastPostAt = Math.max(a.lastPostAt || 0, ...tweets.map((t) => t.createdAt || 0));
  return a;
}

/** 抓取失败时也要往后推一点，别在同一轮里反复撞同一个人 */
export function backoff(a, now) {
  a.lastFetchAt = now;
  a.nextDueAt = now + 6 * 3600 * 1000;
  return a;
}
