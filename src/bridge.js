// 隔离世界的中继：MAIN world 的 net-hook 没有 chrome.* API，
// 靠 window.postMessage 把嗅探结果转给 service worker。

const alive = () => {
  try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
};

// 模板每个请求都会触发一次，没必要每次都写 storage。
// 同一个 op + queryId 组合在本页面只上报一次。
const seen = new Set();

const send = (msg) => {
  if (!alive()) return;
  try { chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError); } catch (e) {}
};

window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.__xfd !== 1) return;
  const d = e.data;

  if (d.kind === 'template') {
    const key = d.op + '|' + d.queryId + '|' + (d.headers && d.headers['x-csrf-token'] || '');
    if (seen.has(key)) return;
    seen.add(key);
    send({ cmd: 'template', op: d.op, queryId: d.queryId, features: d.features, fieldToggles: d.fieldToggles, variables: d.variables, headers: d.headers, origin: d.origin });
    return;
  }

  if (d.kind === 'grok') {
    send({ cmd: 'grokAnswer', text: d.text, raw: d.raw });
    return;
  }

  if (d.kind === 'payload') {
    send({ cmd: 'payload', op: d.op, url: d.url, json: d.json, t: d.t });
  }
});
