/* 只把必要的讀寫開放給畫面（見 開發筆記 D002）；檔案路徑一律由主程序組，畫面只給日期或 'todo' */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('daybook', {
  info: () => ipcRenderer.invoke('info'),
  listDays: () => ipcRenderer.invoke('days:list'),
  readDay: date => ipcRenderer.invoke('day:read', date),
  writeDay: (date, text) => ipcRenderer.invoke('day:write', date, text),
  readTodo: () => ipcRenderer.invoke('todo:read'),
  writeTodo: text => ipcRenderer.invoke('todo:write', text),
  listOpen: () => ipcRenderer.invoke('open:list'),
  search: q => ipcRenderer.invoke('search', q),
  timeline: by => ipcRenderer.invoke('timeline', by),
  // 卡片（見 開發筆記 D021）：src 是日期或 'todo'；i、raw 是那一筆的位置與原文，對不上主程序會拒絕
  listCards: src => ipcRenderer.invoke('cards:list', src),
  addCard: (src, card) => ipcRenderer.invoke('card:add', src, card),
  editCard: (src, i, raw, card) => ipcRenderer.invoke('card:edit', src, i, raw, card),
  deleteCard: (src, i, raw) => ipcRenderer.invoke('card:delete', src, i, raw),
  setStatus: (src, i, raw, status) => ipcRenderer.invoke('card:status', src, i, raw, status),
  addUpdate: (src, i, raw, text) => ipcRenderer.invoke('card:update', src, i, raw, text),
  changeDir: () => ipcRenderer.invoke('dir:change'),
  onChanged: fn => ipcRenderer.on('data:changed', (_, files) => fn(files)),
});
