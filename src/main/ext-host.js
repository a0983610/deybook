/* ============================================================
   外部擴充的程式在這個獨立程序跑（見 開發筆記 D055）：主程序用 Electron 的 utilityProcess 開，
   一次匯入開一個、用完就關；擴充丟錯、卡住、自己結束都只影響這個程序。
   收：{ op: 'detect'|'parse', jobs: [{ id, file }], text }
   回：{ running: 第幾個 }（開始跑哪一個，跑太久時主程序才知道是誰）；
       做完 { ok: true, value }（detect 是每一個認不認得、parse 是拆出來的結果）或 { ok: false, at: 第幾個, error }
   ============================================================ */
'use strict';

/* utilityProcess 用 process.parentPort；parser 測試用 child_process.fork 開，走 process.send */
const port = process.parentPort || {
  on: (_, fn) => process.on('message', data => fn({ data })),
  postMessage: m => process.send(m),
};

/* 擴充的程式檔 module.exports = { formats: { 格式 id: { detect, parse } } } */
function load({ id, file }) {
  const mod = require(file);
  const f = mod && mod.formats && mod.formats[id];
  if (!f || typeof f.detect !== 'function' || typeof f.parse !== 'function') throw new Error(`程式檔沒有給格式「${id}」的 detect 和 parse`);
  return f;
}

port.on('message', async ({ data: { op, jobs, text } }) => {
  let at = 0;
  try {
    const out = [];
    for (; at < jobs.length; at++) {
      port.postMessage({ running: at });
      const f = load(jobs[at]);
      out.push(op === 'detect' ? !!(await f.detect(text)) : await f.parse(text));
    }
    at = jobs.length - 1;
    port.postMessage({ ok: true, value: op === 'detect' ? out : out[0] });
  } catch (e) {
    port.postMessage({ ok: false, at, error: String((e && e.message) || e) });   // 回傳的東西傳不回去（例如裡面有函式）也走這裡
  }
});
