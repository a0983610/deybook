/* ============================================================
   把會上 git 的部分壓成一個 zip，帶回去推上 GitHub 用（見 開發筆記 D128）：
     node tools/srczip.cjs   → dist\daybook-版本號-src.zip（同一版再壓一次會蓋掉）
   zip 裡放兩樣：
     - 檔案：git 管的檔用硬碟上現在的內容（還沒 commit 的修改也算、硬碟上刪掉的不放），
       加上還沒加進 git、也沒被 .gitignore 排除的新檔。node_modules\、dist\ 不會進來。
       內容一個 byte 都照硬碟上的：不用 git archive，它會照 autocrlf 改換行（D128 實測 49 個檔不一樣）。
     - daybook.bundle：全部的 git 歷史（git bundle --all），只到最後一次 commit。
   zip 用 src/main/backup.js 的 zipDir（D097）：先把要放的檔複製到暫存資料夾，壓完就刪。
   ============================================================ */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { zipDir } = require('../src/main/backup.js');

const ROOT = path.resolve(__dirname, '..');
const BUNDLE = 'daybook.bundle';

const git = args => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', maxBuffer: 64 << 20 });
const split = s => s.split('\0').filter(Boolean);

/** 要放的檔：git ls-files -z 的 -c（git 管的）＋ -o（沒被排除的新檔），扣掉 -d（硬碟上刪掉的） */
function pickFiles(cached, others, deleted) {
  const gone = new Set(split(deleted));
  return [...new Set([...split(cached), ...split(others)])].filter(f => !gone.has(f));
}

module.exports = { pickFiles };

if (require.main === module) {
  let tmp;
  try {
    const ver = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    const files = pickFiles(git(['ls-files', '-z', '-c']), git(['ls-files', '-z', '-o', '--exclude-standard']), git(['ls-files', '-z', '-d']));
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daybook-src-'));
    for (const f of files) {
      const to = path.join(tmp, f);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(path.join(ROOT, f), to, { preserveTimestamps: true });
    }
    git(['bundle', 'create', path.join(tmp, BUNDLE), '--all']);
    const out = path.join(ROOT, 'dist', `daybook-${ver}-src.zip`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, zipDir(tmp));
    console.log(`已壓好：${out}`);
    console.log(`  ${files.length} 個檔＋${BUNDLE}（git 歷史），${(fs.statSync(out).size / 1048576).toFixed(2)} MB`);
    if (git(['status', '--porcelain']).trim()) {
      console.log('  注意：還有沒 commit 的修改。檔案照現在的樣子放了，但 git 歷史只到最後一次 commit，推上 GitHub 的不會有這些修改');
    }
  } catch (e) {
    console.error(`壓縮失敗：${(e.stderr && String(e.stderr).trim()) || e.message}`);
    process.exitCode = 1;
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}
