/* ============================================================
   碰到這台電腦的動作（見 開發筆記 D176）：用預設的程式開、在檔案總管中顯示、開瀏覽器、寫系統剪貼簿、丟資源回收筒。
   測試帶 --open-log、--clipboard-file、--trash-dir 時不真的做（D051、D056、D073、D093、D129 等）：
   開的路徑、網址一行一行寫進 open-log；剪貼簿寫進 clipboard-file；丟的搬進 trash-dir——
   都在這裡判斷，主程序的 handler 直接叫，之後新加的功能也不會碰到使用者的剪貼簿、資源回收筒、瀏覽器
   ============================================================ */
'use strict';
const { shell, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');

/* openLog、clipFile、trashDir：測試參數給的位置，沒帶是 null */
function createSys({ openLog, clipFile, trashDir }) {
  const log = p => fs.appendFileSync(openLog, p + '\n');
  return {
    /* 用 Windows 預設的開法開（資料夾用檔案總管、程式就執行）；回錯誤訊息，開得了是空字串（同 shell.openPath） */
    openPath: async p => (openLog ? (log(p), '') : shell.openPath(p)),
    /* 打開它在的資料夾、選到它 */
    showItemInFolder: p => (openLog ? log(p) : shell.showItemInFolder(p)),
    /* 網址用瀏覽器開 */
    openExternal: async url => (openLog ? log(url) : shell.openExternal(url)),
    /* 文字照給的寫（換行要不要轉 \r\n 由叫的地方決定，D093） */
    copyText: text => (clipFile ? fs.writeFileSync(clipFile, text) : clipboard.writeText(text)),
    /* 圖、檔案（ClipboardItem，D129、D143）：測試時 png 寫進 clipboard-file（沒有圖就寫空的）、檔案的網址寫進 <clipboard-file>.uri */
    async copyItem(item) {
      if (!clipFile) return clipboard.write([item]);
      fs.writeFileSync(clipFile, item.types.includes('image/png') ? Buffer.from(await (await item.getType('image/png')).arrayBuffer()) : '');
      fs.writeFileSync(clipFile + '.uri', await (await item.getType('text/uri-list')).text());
    },
    /* 丟資源回收筒（檔案、資料夾都可以），要救回來去那裡還原；測試搬進 trash-dir、名稱照原本的 */
    async trash(p) {
      if (trashDir) fs.renameSync(p, path.join(trashDir, path.basename(p)));
      else await shell.trashItem(p);
    },
  };
}

module.exports = { createSys };
