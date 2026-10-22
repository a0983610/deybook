/* ============================================================
   daybook 畫面：左邊日期清單、中間那一天的編輯區、右邊待辦區＋未結
   檔案一律透過 window.daybook（preload）讀寫；做法見 開發筆記 D020
   ============================================================ */
'use strict';
const api = window.daybook;
const $ = id => document.getElementById(id);
const WEEK = '日一二三四五六';

let info = null;
let current = null;   // 編輯區正在看的日期

function weekday(date) {
  const [y, m, d] = date.split('-').map(Number);
  return WEEK[new Date(y, m - 1, d).getDay()];
}

function showSave(text) { $('saveState').textContent = text; }

/* 自動存檔：停手 600ms 存一次；離開欄位、換日期前先存 */
function autosave(el, save) {
  const st = { dirty: false, timer: null };
  st.flush = async () => {
    clearTimeout(st.timer);
    if (!st.dirty) return;
    st.dirty = false;
    showSave('存檔中…');
    await save(el.value);
    showSave(st.dirty ? '未存檔' : '已存檔');
  };
  el.addEventListener('input', () => {
    st.dirty = true;
    showSave('未存檔');
    clearTimeout(st.timer);
    st.timer = setTimeout(st.flush, 600);
  });
  el.addEventListener('blur', st.flush);
  return st;
}

/* Tab 鍵插入 Tab 字元（舊紀錄的內容都是 Tab 縮排），不要跳到下一個欄位 */
function tabInsert(el) {
  el.addEventListener('keydown', e => {
    if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    document.execCommand('insertText', false, '\t');
  });
}

const editor = $('editor');
const todo = $('todo');
const editorSave = autosave(editor, text => api.writeDay(current, text));
const todoSave = autosave(todo, text => api.writeTodo(text));
tabInsert(editor);
tabInsert(todo);

async function openDay(date) {
  await editorSave.flush();
  current = date;
  editor.value = await api.readDay(date);
  $('dayTitle').textContent = `${date}（${weekday(date)}）` + (date === info.today ? '　今天' : '');
  showSave('');
  for (const b of document.querySelectorAll('#dayList button')) b.classList.toggle('on', b.dataset.date === date);
  editor.focus();
}

async function refreshDays() {
  const days = await api.listDays();
  if (!days.includes(info.today)) days.unshift(info.today);
  const nav = $('dayList');
  nav.textContent = '';
  let month = null;
  for (const date of days) {
    if (date.slice(0, 7) !== month) {
      month = date.slice(0, 7);
      const h = document.createElement('h3');
      h.textContent = month;
      nav.appendChild(h);
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.date = date;
    b.textContent = `${date.slice(5)}（${weekday(date)}）`;
    b.classList.toggle('on', date === current);
    b.addEventListener('click', () => openDay(date));
    nav.appendChild(b);
  }
}

async function refreshOpen() {
  const ul = $('openList');
  ul.textContent = '';
  for (const it of await api.listOpen()) {
    const li = document.createElement('li');
    const st = document.createElement('span');
    st.className = 'st';
    st.textContent = `[${it.status}]`;
    const d = document.createElement('span');
    d.className = 'date';
    d.textContent = it.date.slice(5);
    li.append(st, d, document.createTextNode(it.title));
    li.addEventListener('click', () => openDay(it.date));
    ul.appendChild(li);
  }
}

/* 外部改了檔：正在看的那天、待辦區沒有未存的修改，就換成磁碟上的內容；
   有未存的修改就保留畫面上的（接著自動存檔會蓋回去）（見 開發筆記 D020） */
api.onChanged(async files => {
  if (current && files.some(f => f.endsWith('/' + current + '.md')) && !editorSave.dirty) {
    const text = await api.readDay(current);
    if (text !== editor.value) editor.value = text;
  }
  if (files.includes('待辦.md') && !todoSave.dirty) {
    const text = await api.readTodo();
    if (text !== todo.value) todo.value = text;
  }
  await refreshDays();
  await refreshOpen();
});

$('dirBtn').addEventListener('click', async () => {
  if (await api.changeDir()) location.reload();
});

(async () => {
  info = await api.info();
  $('dirPath').textContent = info.dataDir;
  $('dirPath').title = info.dataDir;
  $('dirBtn').disabled = !info.canChangeDir;
  todo.value = await api.readTodo();
  await refreshDays();
  await refreshOpen();
  await openDay(info.today);
})();
