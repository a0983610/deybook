/* 截圖蓋的那層（見 開發筆記 D129）：只開放這一輪要的幾個，不給讀寫檔（主視窗的 preload.js 不給它） */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shot', {
  frame: () => ipcRenderer.invoke('shot:frame'),     // 這個螢幕按下去那一刻的畫面 { width, height, data（BGRA）}
  ready: () => ipcRenderer.send('shot:ready'),       // 畫好了才顯示，不會先閃一下黑的
  claim: () => ipcRenderer.send('shot:claim'),       // 在這個螢幕開始拉框：其他螢幕的框拿掉
  done: png => ipcRenderer.send('shot:done', png),   // 組好的 png（Uint8Array）：主程序存成下一號、複製
  cancel: () => ipcRenderer.send('shot:cancel'),
  onReset: fn => ipcRenderer.on('shot:reset', () => fn()),
});
