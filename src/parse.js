/*!
 * GraphQL 响应 → 扁平推文列表
 *
 * 不按固定路径取值。X 的时间线响应结构（instructions / entries / modules）
 * 改过很多次，但推文节点本身始终是 { __typename: 'Tweet', rest_id, legacy: {...} }。
 * 所以这里做深度遍历，见到符合特征的节点就收，对结构变化免疫。
 */

const isTweetNode = (n) =>
  n && typeof n === 'object' && n.rest_id &&
  (n.__typename === 'Tweet' || (n.legacy && typeof n.legacy.full_text === 'string'));

// 有些推文被包一层 TweetWithVisibilityResults（敏感内容 / 受限可见）
const unwrap = (n) => (n && n.__typename === 'TweetWithVisibilityResults' && n.tweet) ? n.tweet : n;

const num = (v) => (typeof v === 'number' ? v : parseInt(v, 10) || 0);

function readUser(t) {
  const u = t.core && t.core.user_results && t.core.user_results.result;
  if (!u) return { handle: '', name: '', id: '' };
  // 新版把 screen_name / name 提到了 core 下，旧版在 legacy 下，两边都试
  const c = u.core || {};
  const l = u.legacy || {};
  return {
    handle: c.screen_name || l.screen_name || '',
    name: c.name || l.name || '',
    id: u.rest_id || '',
  };
}

function readText(t) {
  // note_tweet 是长推全文；有它就优先，legacy.full_text 会被截断
  const note = t.note_tweet && t.note_tweet.note_tweet_results && t.note_tweet.note_tweet_results.result;
  if (note && typeof note.text === 'string') return note.text;
  return (t.legacy && t.legacy.full_text) || '';
}

function readMedia(t) {
  const ent = (t.legacy && (t.legacy.extended_entities || t.legacy.entities)) || {};
  const arr = ent.media || [];
  return arr.map((m) => ({ type: m.type, url: m.media_url_https || '' })).filter((m) => m.url);
}

function normalize(t) {
  t = unwrap(t);
  if (!isTweetNode(t)) return null;
  const l = t.legacy || {};
  const author = readUser(t);
  const created = l.created_at ? Date.parse(l.created_at) : 0;

  return {
    id: t.rest_id,
    text: readText(t),
    createdAt: created,
    author,
    url: author.handle ? `https://x.com/${author.handle}/status/${t.rest_id}` : '',
    isRetweet: !!l.retweeted_status_result,
    isReply: !!l.in_reply_to_status_id_str,
    isQuote: !!l.is_quote_status,
    metrics: {
      like: num(l.favorite_count),
      rt: num(l.retweet_count),
      reply: num(l.reply_count),
      quote: num(l.quote_count),
      views: num(t.views && t.views.count),
    },
    media: readMedia(t),
    lang: l.lang || '',
  };
}

/** 深度遍历整个响应，收集所有推文。自动按 id 去重。 */
export function collectTweets(json) {
  const out = new Map();
  const seen = new WeakSet();

  const walk = (n, depth) => {
    if (!n || typeof n !== 'object' || depth > 40) return;
    if (seen.has(n)) return;
    seen.add(n);

    if (isTweetNode(n) || (n.__typename === 'TweetWithVisibilityResults' && n.tweet)) {
      const t = normalize(n);
      if (t && !out.has(t.id)) out.set(t.id, t);
      // 不 return：引用推 / 被转推的原文嵌在里面，继续往下走
    }

    if (Array.isArray(n)) { for (const v of n) walk(v, depth + 1); return; }
    for (const k of Object.keys(n)) walk(n[k], depth + 1);
  };

  walk(json, 0);
  return [...out.values()];
}

/** 从 UserByScreenName 响应里取 userId */
export function readUserId(json) {
  let found = '';
  const walk = (n, depth) => {
    if (found || !n || typeof n !== 'object' || depth > 20) return;
    if (n.__typename === 'User' && n.rest_id) { found = n.rest_id; return; }
    if (Array.isArray(n)) { for (const v of n) walk(v, depth + 1); return; }
    for (const k of Object.keys(n)) walk(n[k], depth + 1);
  };
  walk(json, 0);
  return found;
}

/** 从 Following 响应里收集用户（handle / 名字 / id） */
export function collectUsers(json) {
  const out = new Map();
  const seen = new WeakSet();

  const walk = (n, depth) => {
    if (!n || typeof n !== 'object' || depth > 40) return;
    if (seen.has(n)) return;
    seen.add(n);

    if (n.__typename === 'User' && n.rest_id) {
      const c = n.core || {}, l = n.legacy || {};
      const handle = c.screen_name || l.screen_name || '';
      if (handle && !out.has(handle)) {
        out.set(handle, { handle, name: c.name || l.name || '', id: n.rest_id });
      }
    }

    if (Array.isArray(n)) { for (const v of n) walk(v, depth + 1); return; }
    for (const k of Object.keys(n)) walk(n[k], depth + 1);
  };

  walk(json, 0);
  return [...out.values()];
}

/** 从时间线响应里取下一页游标 */
export function readCursor(json) {
  let cur = '';
  const walk = (n, depth) => {
    if (cur || !n || typeof n !== 'object' || depth > 40) return;
    if (n.cursorType === 'Bottom' && n.value) { cur = n.value; return; }
    if (Array.isArray(n)) { for (const v of n) walk(v, depth + 1); return; }
    for (const k of Object.keys(n)) walk(n[k], depth + 1);
  };
  walk(json, 0);
  return cur;
}
