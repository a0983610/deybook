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
  markDone: (i, raw, date) => ipcRenderer.invoke('card:done', i, raw, date),   // 待處理 → 那一天的已處理（見 開發筆記 D024）
  setHidden: (i, raw, hidden) => ipcRenderer.invoke('card:hidden', i, raw, hidden),   // 待處理的隱藏（見 開發筆記 D026）
  // 匯出 Markdown（見 開發筆記 D035）：{ from, to } 或 { all: true }；回傳存到哪，取消回 null
  exportMd: req => ipcRenderer.invoke('export', req),
  // 匯入（見 開發筆記 D044、D047）：回傳 { format, written, skipped, todoLines, todoSkipped }，取消回 null
  importFile: () => ipcRenderer.invoke('import:file'),
  // 說明頁的「檔案放在哪」（見 開發筆記 D048、D049）：daybook 在這台電腦會放東西的地方
  filesInfo: () => ipcRenderer.invoke('files:info'),
  // 用檔案總管打開其中一格（見 開發筆記 D051）：只給是哪一格（data、userData、extensions、portableExe、unpack、installed、updater、nsu），路徑由主程序算
  openLocation: key => ipcRenderer.invoke('files:open', key),
  // 「匯入格式」頁（見 開發筆記 D055、D056）：{ dir, builtin: [{ label, hint }], exts: [{ name, displayName, version, formats, state, reason }] }
  extList: () => ipcRenderer.invoke('ext:list'),
  enableExt: (name, on) => ipcRenderer.invoke('ext:enable', name, on),   // 啟用／停用，回傳新的清單
  // 請 AI 寫擴充（見 開發筆記 D056）：site 是 'gemini'｜'chatgpt'；aiTry 回 { stage, errors } 或預覽（帶 token），選檔取消回 null
  aiPrompt: () => ipcRenderer.invoke('ai:prompt'),
  aiCopy: () => ipcRenderer.invoke('ai:copy'),
  aiOpen: site => ipcRenderer.invoke('ai:open', site),
  aiTry: reply => ipcRenderer.invoke('ai:try', reply),
  aiInstall: token => ipcRenderer.invoke('ai:install', token),   // 裝試跑過的那一份、啟用，回傳新的清單

  setTheme: t => ipcRenderer.invoke('theme:set', t),   // 'dark'｜'light'｜'system'（見 開發筆記 D034）
  setZoom: f => webFrame.setZoomFactor(f),              // 整個畫面縮放，1＝100%（見 開發筆記 D042）
  undo: () => ipcRenderer.invoke('undo'),   // 復原上一個卡片動作；回傳動作名稱，沒有可復原的回 null（見 開發筆記 D028）
  changeDir: () => ipcRenderer.invoke('dir:change'),
  onChanged: fn => ipcRenderer.on('data:changed', (_, files) => fn(files)),
});
