/* ============================================================
   跑測試（見 e2e測試.md〈跑法〉、開發筆記 D052、D123）：
     node tools/test.cjs          parser ＋ e2e 安靜跑：commit 前跑這個
     node tools/test.cjs --full   parser ＋ e2e 完整跑（真的開出視窗）：使用者說要跑才跑
   照順序跑，parser 沒過就不跑 e2e；後面帶的參數照傳給 e2e。
   結束碼照沒過的那個（全部通過 0）。
   ============================================================ */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const steps = [
  ['parser', ['tests/parser.test.cjs']],
  ['e2e', ['tests/e2e.cjs', ...process.argv.slice(2)]],
];

function main() {
  for (const [name, args] of steps) {
    console.log(`\n===== ${name}：node ${args.join(' ')} =====`);
    const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
    if (r.error) console.error(r.error.message);
    const code = r.status == null ? 1 : r.status;   // 被訊號結束時 status 是 null
    if (r.error || code !== 0) {
      console.log(`\n${name} 沒過（exit ${code}）${name === 'parser' ? '，e2e 不跑' : ''}`);
      return code || 1;
    }
  }
  console.log('\n全部通過');
  return 0;
}

process.exitCode = main();
