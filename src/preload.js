/* 只把必要的讀寫開放給畫面（見 開發筆記 D002）；檔案路徑一律由主程序組，畫面只給日期或 'todo' */
'use strict';
const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron');

contextBridge.exposeInMainWorld('daybook', {
  i18n: () => ipcRenderer.sendSync('i18n:get'),   // 介面語言 { lang, dict }（繁體中文是 { lang: null, dict: null }）；shared/i18n.js 載入時同步拿一次（見 開發筆記 D131）
  info: () => ipcRenderer.invoke('info'),
  listDays: () => ipcRenderer.invoke('days:list'),
  readDay: date => ipcRenderer.invoke('day:read', date),   // 文字模式唯讀（見 開發筆記 D141）：只給讀
  readTodo: () => ipcRenderer.invoke('todo:read'),
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
  flagged: () => ipcRenderer.invoke('flagged'),   // 標記清單 { items（搜尋結果的樣子，多帶 raw，可以直接取消標記）, cats（同 flagCats） }（D157）
  flagCats: () => ipcRenderer.invoke('flag:cats'),   // 分類清單（自訂的＋紀錄裡有的），照順序
  addFlagCat: name => ipcRenderer.invoke('flag:addCat', name),   // 加新分類，回傳整理過的名稱
  // 剪貼簿（見 開發筆記 D093、D096）：一筆是 { title, body }；i、raw 跟卡片一樣，對不上主程序會拒絕
  listSnips: () => ipcRenderer.invoke('snips:list'),
  addSnip: s => ipcRenderer.invoke('snip:add', s),
  editSnip: (i, raw, s) => ipcRenderer.invoke('snip:edit', i, raw, s),
  deleteSnip: (i, raw) => ipcRenderer.invoke('snip:delete', i, raw),
  moveSnip: (i, raw, to) => ipcRenderer.invoke('snip:move', i, raw, to),   // 搬到第 to 筆（D125）
  copyText: text => ipcRenderer.invoke('snip:copy', text),   // 寫進剪貼簿
  // 記事本（見 開發筆記 D102）：一份一個檔。可以開資料夾（D116）：記事、資料夾都用 記事本\ 底下的相對路徑認
  // （/ 隔開，記事不帶 .txt，例：工作/週會）；listNotes 回 { files, dirs, times }（times：每份的 [修改時間, 建立時間]，D132），順序畫面自己排。取名、改名、搬回傳新的相對路徑。
  // 存檔照 VS Code（D105）：新記事先不建檔，newNoteName 只給名稱，createNote 取名存檔時才建（存在 dir 那個資料夾）；others 是還沒存的新記事的名稱
  listNotes: () => ipcRenderer.invoke('notes:list'),
  readNote: rel => ipcRenderer.invoke('note:read', rel),
  writeNote: (rel, text) => ipcRenderer.invoke('note:write', rel, text),
  newNoteName: (others, dir) => ipcRenderer.invoke('note:newName', others, dir),
  createNote: (dir, name, text, others) => ipcRenderer.invoke('note:create', dir, name, text, others),
  renameNote: (from, to, others) => ipcRenderer.invoke('note:rename', from, to, others),   // to 是新的名稱（同一個資料夾）
  deleteNote: (rel, text) => ipcRenderer.invoke('note:delete', rel, text),   // 丟資源回收筒，不問；有 text（改過沒存的）先寫進去再丟
  moveNote: (from, to, isDir) => ipcRenderer.invoke('note:move', from, to, isDir),   // 拖進 to 那個資料夾（'' 是最上層）
  addNoteDir: (parent, name) => ipcRenderer.invoke('noteDir:add', parent, name),
  renameNoteDir: (from, to) => ipcRenderer.invoke('noteDir:rename', from, to),
  deleteNoteDir: (rel, dirty) => ipcRenderer.invoke('noteDir:delete', rel, dirty),   // 整個丟資源回收筒；dirty 是裡面改過沒存的 [{ name, text }]，先寫進去再丟
  notePath: (rel, isDir) => ipcRenderer.invoke('note:path', rel, isDir),       // 右鍵「複製路徑」（D117）：完整路徑
  revealNote: (rel, isDir) => ipcRenderer.invoke('note:reveal', rel, isDir),   // 右鍵「在檔案總管中顯示」（D117）
  // 沒存的內容暫存在這台電腦（D105）：{ untitled: [{ name, text, folder }], dirty: [{ name, text }] }，dir 是紀錄資料夾
  readNoteBackup: dir => ipcRenderer.invoke('noteBackup:read', dir),
  writeNoteBackup: (dir, b) => ipcRenderer.invoke('noteBackup:write', dir, b),
  writeNoteBackupSync: (dir, b) => ipcRenderer.sendSync('noteBackup:writeSync', dir, b),   // 關視窗前（beforeunload）用，寫完才回來
  // 文件檢視（原本叫 MD 檢視，見 開發筆記 D118、D122）：唯讀看釘住的資料夾裡的 .md、.html，一份用完整路徑認。mdList 回 [{ dir, files: [相對路徑，/ 隔開], times（同 listNotes，D132）, missing }]；
  // mdAdd 跳選資料夾的視窗，回 { dir, dup }（取消回 null）；mdRead 回 .md 轉好的 { html } 或 .html 的 { url }；mdResolve 把文件裡的相對連結換成完整路徑（開不了回 null）
  mdList: () => ipcRenderer.invoke('md:list'),
  mdAdd: () => ipcRenderer.invoke('md:add'),
  mdRemove: dir => ipcRenderer.invoke('md:remove', dir),
  mdRead: file => ipcRenderer.invoke('md:read', file),
  mdResolve: (from, href) => ipcRenderer.invoke('md:resolve', from, href),
  mdLink: url => ipcRenderer.invoke('md:link', url),   // 用瀏覽器開 http、https、mailto 的連結
  mdReveal: file => ipcRenderer.invoke('md:reveal', file),   // 頁籤、清單右鍵「在檔案總管中顯示」（D120、D121）：.md 或資料夾
  onMdChanged: fn => ipcRenderer.on('md:changed', () => fn()),
  mdBrowser: file => ipcRenderer.invoke('md:browser', file),   // 右鍵「用瀏覽器開」（D122，只有 .html）
  onMdOpen: fn => ipcRenderer.on('md:open', (_, file, hash) => fn(file, hash)),   // .html 裡點了連到別份文件的連結（D122）：開成頁籤；hash 是 # 後面的（D159）
  docFind: (op, arg) => ipcRenderer.invoke('doc:find', op, arg),   // .html 找字（D149）：主程序在 iframe 裡跑 shared/docfind.js 的 pageOp，回 { q, n, at }
  // 截圖（見 開發筆記 D129）：一張用截圖資料夾裡的相對路徑 rel 認（639.png、保留/名稱.png）。shotList 回 { dir, today, items（編號的）, kept（保留的）}，
  // 每張 { rel, name, mtimeMs, day }；shotCapture 蓋一層框選，存好回 { name, rel }、取消回 null；shotClean 的 dry 只算不丟，回 { cut, n }
  shotList: () => ipcRenderer.invoke('shots:list'),
  shotCapture: () => ipcRenderer.invoke('shot:capture'),
  shotCopy: rel => ipcRenderer.invoke('shot:copy', rel),                 // 一張給 rel（圖＋檔案）；框選好幾張給 [rel…]（只放檔案，D143）
  shotKeep: (rel, name) => ipcRenderer.invoke('shot:keep', rel, name),   // 取名搬進 保留\，回傳新的 rel
  shotPrint: rel => ipcRenderer.invoke('shot:print', rel),               // 跳系統的列印對話框（D142）
  shotClean: (days, dry) => ipcRenderer.invoke('shot:clean', days, dry),
  shotPickDir: () => ipcRenderer.invoke('shot:pickDir'),                 // 換截圖資料夾，回傳新的位置，取消回 null
  onShotChanged: fn => ipcRenderer.on('shot:changed', () => fn()),
  // 常用（見 開發筆記 D134）：一筆用第幾筆＋那一筆的 target 認，對不上主程序會拒絕。launchList 回 [{ name, target, kind（file、dir、url、missing）, icon, index }]；
  // launchAdd 跳選擇視窗（dir 是選資料夾），回 { name, dup }（取消回 null）；launchAddPaths 是從檔案總管拖進來的，回 { added, dup }（都是名稱）
  launchList: () => ipcRenderer.invoke('launch:list'),
  launchAdd: dir => ipcRenderer.invoke('launch:add', dir),
  launchAddUrl: (name, url) => ipcRenderer.invoke('launch:addUrl', name, url),
  launchAddPaths: paths => ipcRenderer.invoke('launch:addPaths', paths),
  launchEdit: (i, target, v) => ipcRenderer.invoke('launch:edit', i, target, v),   // v：{ name, url（網址的那筆才有）}
  launchRemove: (i, target) => ipcRenderer.invoke('launch:remove', i, target),
  launchMove: (i, target, to) => ipcRenderer.invoke('launch:move', i, target, to),
  launchOpen: (i, target) => ipcRenderer.invoke('launch:open', i, target),
  launchReveal: (i, target) => ipcRenderer.invoke('launch:reveal', i, target),
  pathForFile: file => webUtils.getPathForFile(file),   // 拖進來的檔在硬碟上的路徑（electron.d.ts：取代原本 File 的 .path）；不是硬碟上的檔回 ''
  range: (from, to) => ipcRenderer.invoke('range', from, to),   // 回顧：from～to 每一天的已處理，搜尋結果的樣子，舊的在前（見 開發筆記 D087）
  // 匯出（見 開發筆記 D035、D078）：能匯出的格式 [{ key, label, hint, extension, ext }]（ext 是擴充名稱，內建的是 null）；
  // 匯出 { format: key, from, to } 或 { format: key, all: true }，回傳存到哪，取消回 null
  exportFormats: () => ipcRenderer.invoke('export:formats'),
  exportFile: req => ipcRenderer.invoke('export', req),
  backup: () => ipcRenderer.invoke('backup'),   // 整個紀錄資料夾壓成 zip、跳存檔視窗（見 開發筆記 D097），回傳存到哪，取消回 null
  // 匯入（見 開發筆記 D044、D047、D063）：回傳 { format, written, skipped, merged, todoLines, todoSkipped }，取消回 null
  importFile: () => ipcRenderer.invoke('import:file'),
  // 說明頁的「檔案放在哪」（見 開發筆記 D048、D049）：daybook 在這台電腦會放東西的地方
  filesInfo: () => ipcRenderer.invoke('files:info'),
  // 用檔案總管打開其中一格（見 開發筆記 D051）：只給是哪一格（data、shots、userData、extensions、skins、portableExe、unpack、installed、updater、nsu），路徑由主程序算
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
  // 「語言」頁（見 開發筆記 D131）：{ dir, current（null 是繁體中文）, packs: [{ id, name, lang, done, missing, total, state, reason }] }
  langList: () => ipcRenderer.invoke('lang:list'),
  setLang: id => ipcRenderer.invoke('lang:set', id),   // 換好畫面自己重新載入
  langPrompt: target => ipcRenderer.invoke('lang:prompt', target),
  langCopy: target => ipcRenderer.invoke('lang:copy', target),
  // 檢查 AI 回的：{ name, lang, n（認得幾條）, problems: [{ id, key, text, why }], more, missing（裝了還缺幾條）, total, merge（同名已經裝了的）, token }
  langCheck: (reply, target) => ipcRenderer.invoke('lang:check', reply, target),
  langFeedback: token => ipcRenderer.invoke('lang:feedback', token),   // 有問題的那幾條複製給 AI
  langInstall: token => ipcRenderer.invoke('lang:install', token),     // 裝好、換成它；畫面自己重新載入
  deleteLang: id => ipcRenderer.invoke('lang:delete', id),             // 回傳新的清單；reload 是 true（刪的是現在用的）畫面要重新載入

  setTheme: t => ipcRenderer.invoke('theme:set', t),   // 'dark'｜'light'｜'system'（見 開發筆記 D034）
  setZoom: f => webFrame.setZoomFactor(f),              // 整個畫面縮放，1＝100%（見 開發筆記 D042）
  undo: () => ipcRenderer.invoke('undo'),   // 復原上一個卡片動作；回傳動作名稱，沒有可復原的回 null（見 開發筆記 D028）
  changeDir: () => ipcRenderer.invoke('dir:change'),
  onChanged: fn => ipcRenderer.on('data:changed', (_, files) => fn(files)),
});
