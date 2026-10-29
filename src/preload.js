/* 只把必要的讀寫開放給畫面（見 開發筆記 D002）；檔案路徑一律由主程序組，畫面只給日期或 'todo' */
'use strict';
const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('daybook', {
  info: () => ipcRenderer.invoke('info'),
  listDays: () => ipcRenderer.invoke('days:list'),
  readDay: date => ipcRenderer.invoke('day:read', date),
  writeDay: (date, text) => ipcRenderer.invoke('day:write', date, text),
  readTodo: () => ipcRenderer.invoke('todo:read'),
  writeTodo: text => ipcRenderer.invoke('todo:write', text),
  search: q => ipcRenderer.invoke('search', q),
  timeline: by => ipcRenderer.invoke('timeline', by),
  suggestions: () => ipcRenderer.invoke('suggest'),   // 自動補完的候選 { titles, words, lines }（見 開發筆記 D031、D032、D054）
  // 卡片（見 開發筆記 D021）：src 是日期或 'todo'；i、raw 是那一筆的位置與原文，對不上主程序會拒絕
  listCards: src => ipcRenderer.invoke('cards:list', src),
  addCard: (src, card) => ipcRenderer.invoke('card:add', src, card),
  editCard: (src, i, raw, card) => ipcRenderer.invoke('card:edit', src, i, raw, card),
  deleteCard: (src, i, raw) => ipcRenderer.invoke('card:delete', src, i, raw),
  setStatus: (src, i, raw, status) => ipcRenderer.invoke('card:status', src, i, raw, status),
  addUpdate: (src, i, raw, text) => ipcRenderer.invoke('card:update', src, i, raw, text),
  markDone: (i, raw, date, unfinished) => ipcRenderer.invoke('card:done', i, raw, date, unfinished),   // 待處理 → 那一天的已處理（見 開發筆記 D024）；unfinished 是順便標「未完」（D091）
  setHidden: (i, raw, hidden) => ipcRenderer.invoke('card:hidden', i, raw, hidden),   // 待處理的隱藏（見 開發筆記 D026）
  setFlag: (src, i, raw, flagged, cat) => ipcRenderer.invoke('card:flag', src, i, raw, flagged, cat),   // 已處理的標記（見 開發筆記 D072）；cat 是分類，沒給是未分類（D076）
  flagged: () => ipcRenderer.invoke('flagged'),   // 標記清單：搜尋結果的樣子，多帶 raw（可以直接取消標記）
  flagCats: () => ipcRenderer.invoke('flag:cats'),   // 分類清單（自訂的＋紀錄裡有的），照順序
  addFlagCat: name => ipcRenderer.invoke('flag:addCat', name),   // 加新分類，回傳整理過的名稱
  range: (from, to) => ipcRenderer.invoke('range', from, to),   // 回顧：from～to 每一天的已處理，搜尋結果的樣子，舊的在前（見 開發筆記 D087）
  // 匯出（見 開發筆記 D035、D078）：能匯出的格式 [{ key, label, hint, extension, ext }]（ext 是擴充名稱，內建的是 null）；
  // 匯出 { format: key, from, to } 或 { format: key, all: true }，回傳存到哪，取消回 null
  exportFormats: () => ipcRenderer.invoke('export:formats'),
  exportFile: req => ipcRenderer.invoke('export', req),
  // 匯入（見 開發筆記 D044、D047、D063）：回傳 { format, written, skipped, merged, todoLines, todoSkipped }，取消回 null
  importFile: () => ipcRenderer.invoke('import:file'),
  // 說明頁的「檔案放在哪」（見 開發筆記 D048、D049）：daybook 在這台電腦會放東西的地方
  filesInfo: () => ipcRenderer.invoke('files:info'),
  // 用檔案總管打開其中一格（見 開發筆記 D051）：只給是哪一格（data、userData、extensions、skins、portableExe、unpack、installed、updater、nsu），路徑由主程序算
  openLocation: key => ipcRenderer.invoke('files:open', key),
  // 「格式」頁（見 開發筆記 D055、D056、D078）：{ dir, builtin: [{ label, hint }], builtinExport: [{ label, hint, extension }],
  //   exts: [{ folder, name, displayName, version, formats, exportFormats, state, reason }] }
  extList: () => ipcRenderer.invoke('ext:list'),
  enableExt: (name, on) => ipcRenderer.invoke('ext:enable', name, on),   // 啟用／停用，回傳新的清單
  deleteExt: folder => ipcRenderer.invoke('ext:delete', folder),   // 整個資料夾丟資源回收筒，回傳新的清單（見 開發筆記 D081）
  // 請 AI 寫擴充（見 開發筆記 D056、D079）：kind 是 'import'｜'export'；site 是 'gemini'｜'chatgpt'；
  // aiTry 回 { kind, stage, errors } 或預覽（帶 token），選檔取消回 null
  aiPrompt: kind => ipcRenderer.invoke('ai:prompt', kind),
  aiCopy: kind => ipcRenderer.invoke('ai:copy', kind),
  aiOpen: site => ipcRenderer.invoke('ai:open', site),
  aiTry: (reply, kind) => ipcRenderer.invoke('ai:try', reply, kind),
  aiSave: (token, i) => ipcRenderer.invoke('ai:save', token, i),   // 匯出格式試跑的結果存一份（第 i 種格式），回傳存到哪，取消回 null
  aiFeedback: r => ipcRenderer.invoke('ai:feedback', r),   // 沒通過的結果組成一段、複製給 AI（D061）
  aiInstall: token => ipcRenderer.invoke('ai:install', token),   // 裝試跑過的那一份、啟用，回傳新的清單
  // 「外觀」頁（見 開發筆記 D062）：{ dir, skins: [{ folder, name, displayName, version, parts, state, reason }] }；一次啟用一個
  skinList: () => ipcRenderer.invoke('skin:list'),
  enableSkin: (name, on) => ipcRenderer.invoke('skin:enable', name, on),   // 啟用／停用，回傳新的清單
  deleteSkin: folder => ipcRenderer.invoke('skin:delete', folder),   // 整個資料夾丟資源回收筒，回傳新的清單（見 開發筆記 D073）
  skinLoad: () => ipcRenderer.invoke('skin:load'),   // 啟用的那個的圖 { background: [{ url, opacity, position, size }, …] | null, empty: { url } | null }，沒啟用回 null
  // 「用圖檔做一個」（D066、D067）：選圖 { name, url }（取消回 null）；建立並啟用 { displayName, background: [{ url, opacity, position, size }, …] | null, empty: { url } | null }，回傳 { name, dir, skins }
  skinPick: () => ipcRenderer.invoke('skin:pick'),
  skinCreate: spec => ipcRenderer.invoke('skin:create', spec),

  setTheme: t => ipcRenderer.invoke('theme:set', t),   // 'dark'｜'light'｜'system'（見 開發筆記 D034）
  setZoom: f => webFrame.setZoomFactor(f),              // 整個畫面縮放，1＝100%（見 開發筆記 D042）
  undo: () => ipcRenderer.invoke('undo'),   // 復原上一個卡片動作；回傳動作名稱，沒有可復原的回 null（見 開發筆記 D028）
  changeDir: () => ipcRenderer.invoke('dir:change'),
  onChanged: fn => ipcRenderer.on('data:changed', (_, files) => fn(files)),
});
