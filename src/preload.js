/* 只把必要的讀寫開放給畫面（見 開發筆記 D002）；檔案路徑一律由主程序組，畫面只給日期 */
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
  changeDir: () => ipcRenderer.invoke('dir:change'),
  onChanged: fn => ipcRenderer.on('data:changed', (_, files) => fn(files)),
});
