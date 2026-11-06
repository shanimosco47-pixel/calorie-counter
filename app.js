import { store, db, put, remove, newId, getSetting, setSetting, dumpAll, restoreAll, recentFoods } from './lib/db.js';
import { createSync } from './lib/sync.js';
import { supabaseRemote } from './lib/remote.js';
import { buildIndex, matchFood, normalize, queryNegations, foodPreference } from './lib/match.js';
import {
  MEALS, ACTIVITY, GOALS, gramsFor, nutrientsFor, sumEntries, totalsByMeal, dailyTarget, targetInfo,
  macroTargets, mealForHour, isoDate, addDays, makeBackup, parseBackup, defaultAmount,
} from './lib/calc.js';
import { lookupBarcode } from './lib/off.js';
import { analyzePhoto, analyzeText, pickFood, amountFor, dbHint, VisionError, ERROR_TEXT, CHAT_ERROR_TEXT, NO_RETRY } from './lib/vision.js';
import { BUILD } from './build-info.js';
import { createUpdater } from './lib/update.js';

export const APP_VERSION = '1.12.0';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n)) : 0).toLocaleString('he-IL');
const fmt1 = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n) * 10) / 10 : 0);

const state = {
  date: isoDate(),
  today: isoDate(),   // the calendar day the app last saw; when it changes, "today" moves with it
  view: 'today',
  addMeal: mealForHour(new Date().getHours()),
  addTab: 'recent',
  foods: [],          // Tzameret
  units: {},
  myFoods: [],
  favIds: new Set(),
  byId: new Map(),
  index: [],
  target: 2000,
  range: 7,
  charts: {},
};

// ---------- data ----------

async function loadFoods() {
  const res = await fetch('data/tzameret.json');
  const data = await res.json();
  state.foods = data.foods;
  state.units = data.units;
  await refreshMyFoods();
}

async function refreshMyFoods() {
  state.myFoods = await db.myFoods.toArray();
  state.favIds = new Set((await db.favorites.toArray()).map((f) => f.foodId));
  state.byId = new Map();
  for (const f of state.foods) state.byId.set(f.id, f);
  for (const f of state.myFoods) state.byId.set(f.id, f);
  state.index = buildIndex([...state.myFoods, ...state.foods]);
}

async function loadTarget() {
  const mode = await getSetting('targetMode', 'calc');
  const profile = await getSetting('profile', null);
  const manual = await getSetting('manualTarget', null);
  // the calculated target uses the latest weigh-in; with none left (e.g. a typo was deleted), the
  // weight entered in Settings. Weigh-ins never overwrite the profile, so deleting one always undoes it.
  const latest = await db.weights.orderBy('date').last();
  if (mode === 'manual' && manual) state.target = manual;
  else if (profile) state.target = dailyTarget({ ...profile, weight: latest?.kg ?? profile.weight });
  else state.target = 2000;
}

// Liquids are stored in grams like everything else (1 ml counted as 1 g) but shown in ml.
const isLiquid = (food) => !!food?.liquid;
const baseWord = (food) => (isLiquid(food) ? 'מ״ל' : 'גרם');
const baseShort = (food) => (isLiquid(food) ? 'מ״ל' : 'ג׳');

function unitLabel(food, code) {
  if (code === 'g') return baseWord(food);
  const m = (food.m || []).find(([c]) => String(c) === String(code));
  if (m && m[2]) return m[2];
  if (code === 'serving') return 'מנה (לפי היצרן)';
  if (code === 'egg') return 'ביצה';
  return state.units[String(code).replace(/^b/, '')] || String(code);
}

function amountText(e) {
  const food = state.byId.get(e.foodId) || { m: [] };
  if (!e.unit || e.unit === 'g') return `${fmt(e.grams)} ${baseWord(food)}`;
  return `${e.amount} × ${unitLabel(food, e.unit)} (${fmt(e.grams)} ${baseShort(food)})`;
}


// ---------- toast ----------

let toastTimer;
function toast(text, undo) {
  const el = $('#toast');
  $('#toast-text').textContent = text;
  const btn = $('#toast-undo');
  btn.hidden = !undo;
  btn.onclick = async () => { el.hidden = true; await undo(); };
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

// ---------- updates ----------
// Every deploy writes build-info.js (baked into this copy) and version.json (fetched fresh).
// lib/update.js installs a newer build and reloads only when it is really installed and the
// user is not in the middle of something; otherwise it waits until the app goes to background.

function builtText(iso) {
  if (!iso) return 'גרסת פיתוח';
  const d = new Date(iso);
  return d.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: 'numeric' })
    + ' ' + d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
}

// the field the user has typed into since focusing it (unsaved text an update reload would lose)
let typedIn = null;
let savedApiKey = '';   // what the API key field showed when loaded or last saved
document.addEventListener('focusin', () => { typedIn = null; });
// html5-qrcode's video.play() is interrupted when the scanner is closed while the camera starts;
// that is expected, not an error
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason?.name === 'AbortError' && /play\(\) request was interrupted/.test(e.reason?.message || '')) e.preventDefault();
});
document.addEventListener('input', (e) => { typedIn = e.target; });
// a submitted or committed field is no longer "mid-typing" (e.g. a weight saved with Enter keeps focus)
document.addEventListener('submit', () => { typedIn = null; }, true);
document.addEventListener('change', () => { typedIn = null; }, true);

let localStore = null;
try { localStore = window.localStorage; } catch { /* storage blocked */ }

const updater = createUpdater({
  build: BUILD,
  fetchLatest: async () => {
    try {
      const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
      return res.ok ? await res.json() : null;
    } catch { return null; }
  },
  serviceWorker: 'serviceWorker' in navigator && location.protocol !== 'file:' ? navigator.serviceWorker : null,
  // a cache that exists but lacks the page is a failed install, not an installed build
  cacheExists: async (version) => {
    try {
      const name = `kalorit-app-${version}`;
      return (await caches.has(name)) && !!(await (await caches.open(name)).match('index.html'));
    } catch { return false; }
  },
  isBusy: () => !!document.querySelector('dialog[open]') || store.isWriting()
    || (state.view === 'add' && $('#search').value.trim() !== '')
    || (typedIn && typedIn === document.activeElement)   // mid-typing in a field (settings, weight, sync code, key)
    // a key typed or pasted but not saved yet, even after tapping "show" or leaving to compare it
    || ($('#api-key') && $('#api-key').value.trim() !== savedApiKey)
    // the chat lives in memory: a reload would drop its replies and their undo / edit buttons
    || (state.view === 'chat' && (chat.msgs.some((m) => (m.ids && !m.undone) || (m.ask && !m.dropped && !m.replacedBy))
      || $('#chat-input').value.trim() !== '')),
  // the camera or picker is open over the app, a paid recognition is running, or its items await approval
  // (or a chat message is being logged)
  keepAlive: () => photo.picking || !!photo.ctrl || photo.confirming || !!photo.stream || chat.busy > 0,
  reload: () => location.reload(),
  notify: (event, info) => {
    if (event === 'updated') toast(`האפליקציה עודכנה ✓ ${builtText(info.builtAt)}`);
    else if (event === 'current') toast(`האפליקציה מעודכנת ✓ (${builtText(info.builtAt)})`);
    else if (event === 'offline') toast('אין חיבור לשרת, נסו שוב מאוחר יותר');
    else if (event === 'updating') toast('מוריד גרסה חדשה…');
    else if (event === 'failed') toast('העדכון עדיין לא זמין בשרת, ננסה שוב בעוד כמה דקות');
  },
  storage: localStore,
});

// ---------- install ----------
// Chrome's own "Add to Home screen" sheet can wrongly report the app as installed when other
// apps from the same github.io origin are installed. beforeinstallprompt goes straight to the
// real install flow, so the app offers its own button whenever Chrome allows installing.

let installPrompt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('#install-card').hidden = isStandalone();
});

window.addEventListener('appinstalled', () => {
  installPrompt = null;
  $('#install-card').hidden = true;
  toast('קלורית הותקנה ✓ האייקון יופיע במסך הבית');
});

async function installApp() {
  if (!installPrompt) return;
  const prompt = installPrompt;
  installPrompt = null;
  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  if (outcome !== 'accepted') installPrompt = prompt;   // allow another try
  $('#install-card').hidden = outcome === 'accepted';
}

// ---------- cloud sync ----------

const sync = createSync(store, supabaseRemote(), {
  onStatus: renderSyncStatus,
  onApplied: async () => {
    await refreshMyFoods();
    await loadTarget();
    if (state.view === 'today') renderToday();
    else if (state.view === 'history') renderHistory();
    else if (state.view === 'add') renderResults();
    else if (state.view === 'chat') renderChat();
  },
});
window.kaloritSync = sync;   // for tests

function timeText(ms) {
  const d = new Date(ms);
  const sameDay = isoDate(d) === isoDate();
  return sameDay ? d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' }) + ' ' + d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
}

async function renderSyncStatus(st) {
  st = st || await sync.status();
  $('#sync-off').hidden = !!st.code;
  $('#sync-on').hidden = !st.code;
  if (!st.code) return;
  $('#sync-code').textContent = st.code;
  const el = $('#sync-status');
  if (st.lastError) {
    el.className = 'sync-status err';
    el.textContent = `⚠️ לא סונכרן: ${st.lastError}. ננסה שוב אוטומטית.`;
  } else if (st.lastSync) {
    el.className = 'sync-status ok';
    el.textContent = `✓ מסונכרן · עודכן ב-${timeText(st.lastSync)}` + (st.pending ? ` · ${st.pending} שינויים ממתינים` : '')
      + (st.skipped ? ` · ${st.skipped} פריטים פגומים לא נשמרו בענן` : '');
  } else {
    el.className = 'sync-status';
    el.textContent = 'מסנכרן…';
  }
}

async function connectSync(code) {
  const res = await sync.connect(code);
  if (res?.error) toast('הסנכרון הופעל, אבל השרת לא זמין כרגע. ננסה שוב אוטומטית.');
  else toast(res?.changed ? `הסנכרון הופעל ✓ התקבלו ${res.changed} פריטים` : 'הסנכרון הופעל ✓');
  await renderSyncStatus();
}

async function shareCode() {
  const code = (await sync.status()).code;
  const text = `קוד הסנכרון של קלורית: ${code}`;
  try {
    if (navigator.share) { await navigator.share({ title: 'קלורית', text }); return; }
  } catch (err) { if (err.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(code); toast('הקוד הועתק'); }
  catch { toast('סמנו את הקוד והעתיקו אותו'); }
}

// ---------- navigation ----------

// A new day while the app stayed open (Android keeps installed apps alive overnight): if the user
// was looking at "today", move to the new today, and suggest the meal for the current hour again.
function rollDay() {
  const now = isoDate();
  if (now === state.today) return false;
  if (state.date === state.today) state.date = now;
  state.today = now;
  state.addMeal = mealForHour(new Date().getHours());
  return true;
}

// Each screen other than "today" is a history step, so Android's back button returns to "today"
// instead of closing the app.
function show(view, { fromHistory = false } = {}) {
  rollDay();
  if (!fromHistory) {
    if (view !== 'today' && history.state?.view !== view) history[history.state?.view ? 'replaceState' : 'pushState']({ view }, '');
    else if (view === 'today' && history.state?.view) history.back();
  }
  state.view = view;
  for (const v of $$('.view')) v.hidden = v.id !== `view-${view}`;
  for (const b of $$('.bottomnav button')) {
    if (b.dataset.view === view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  window.scrollTo(0, 0);
  if (view === 'today') renderToday();
  if (view === 'add') { renderMealPicker(); renderResults(); }
  if (view === 'history') renderHistory();
  if (view === 'settings') renderSettings();
  document.body.dataset.view = view;
  if (view === 'chat') { chat.scrolledFor = ''; fitChatInput(); renderChat(); if (matchMedia('(pointer: fine)').matches) $('#chat-input').focus(); }
  else stopListening();
}

function renderDate() {
  const today = isoDate();
  const d = new Date(state.date + 'T12:00:00');
  let label = d.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });
  if (state.date === today) label = 'היום · ' + label;
  else if (state.date === addDays(today, -1)) label = 'אתמול · ' + label;
  $('#date-label').textContent = label;
  $('#day-next').disabled = state.date >= today;
  $('#day-next').style.visibility = state.date >= today ? 'hidden' : 'visible';
}

function setDate(iso) {
  state.date = iso;
  renderDate();
  if (state.view !== 'today' && state.view !== 'add') show('today');
  else if (state.view === 'today') renderToday();
}

// ---------- today ----------

async function renderToday() {
  renderDate();
  const entries = await db.log.where('date').equals(state.date).sortBy('ts');
  const total = sumEntries(entries);
  const byMeal = totalsByMeal(entries);
  const remaining = state.target - total.kcal;

  $('#target').textContent = fmt(state.target);
  $('#eaten').textContent = fmt(total.kcal);
  $('#remaining').textContent = fmt(Math.abs(remaining));
  $('#remaining-label').textContent = remaining >= 0 ? 'נותרו' : 'מעל היעד';
  const C = 2 * Math.PI * 52;
  const ratio = Math.min(1, total.kcal / Math.max(1, state.target));
  const fg = $('#ring-fg');
  fg.style.strokeDasharray = C;
  fg.style.strokeDashoffset = C * (1 - ratio);
  $('#ring').classList.toggle('over', remaining < 0);

  const mt = macroTargets(state.target);
  $('#macros').innerHTML = [['p', 'חלבון'], ['c', 'פחמימות'], ['f', 'שומן']].map(([k, label]) => `
    <div class="macro" data-testid="macro-${k}">${label}<b>${fmt(total[k])} / ${mt[k]} ג׳</b>
      <div class="bar"><i style="width:${Math.min(100, (total[k] / mt[k]) * 100)}%;background:var(--${k})"></i></div>
    </div>`).join('');

  $('#meals').innerHTML = MEALS.map((meal) => {
    const list = entries.filter((e) => e.meal === meal.id);
    return `<div class="card" data-testid="meal-${meal.id}">
      <div class="meal-head">
        <div><h2>${meal.label}</h2><span class="meal-kcal" data-testid="meal-kcal-${meal.id}">${fmt(byMeal[meal.id].kcal)} קק״ל</span></div>
        <button class="meal-add" data-add-meal="${meal.id}" data-testid="add-${meal.id}">+ הוספה</button>
      </div>
      ${list.length ? `<ul class="list compact">${list.map((e) => `
        <li data-testid="entry">
          <button class="row grow" data-edit="${esc(e.id)}">
            <span class="grow"><span class="name">${esc(e.name)}</span><span class="sub">${esc(amountText(e))}</span></span>
            <span class="kcal">${fmt(e.kcal)}</span>
          </button>
          <button class="del" data-del="${esc(e.id)}" aria-label="מחיקת ${esc(e.name)}">🗑</button>
        </li>`).join('')}</ul>` : ''}
    </div>`;
  }).join('');

  await renderQuick();
}

async function renderQuick() {
  const recent = await recentFoods(10);
  $('#quick-card').hidden = recent.length === 0;
  $('#quick').innerHTML = recent.map((e) => `
    <button class="chip" data-quick="${esc(e.id)}" data-testid="quick-chip" title="${esc(e.name)}">
      ${esc(String(e.name ?? '').split(',')[0])} <small>${fmt(e.kcal)}</small>
    </button>`).join('');
}

async function quickAdd(entryId) {
  const src = await db.log.get(entryId);
  if (!src) return;
  const meal = state.date === isoDate() ? mealForHour(new Date().getHours()) : src.meal;
  const { id, mt, ...copy } = src;
  const added = await put('entries', { ...copy, id: newId(), date: state.date, meal, ts: Date.now() });
  await renderToday();
  const mealLabel = MEALS.find((m) => m.id === meal).label;
  toast(`נוסף ל${mealLabel}: ${src.name.split(',')[0]}`, async () => { await remove('entries', added.id); renderToday(); });
}

// ---------- add / search ----------

function renderMealPicker() {
  $('#meal-picker').innerHTML = MEALS.map((m) => `
    <button role="radio" aria-checked="${m.id === state.addMeal}" data-meal="${m.id}" data-testid="pick-${m.id}">${m.label}</button>`).join('');
}

function foodRow(food, extra = '', { deletable = false } = {}) {
  const tag = food.src === 'off' ? '<span class="tag">ברקוד</span>' : food.src === 'ai' ? '<span class="tag">הערכה</span>'
    : food.id.startsWith('u') ? '<span class="tag">שלי</span>' : '';
  return `<li><button class="row" data-food="${esc(food.id)}" data-testid="result">
    <span class="grow"><span class="name">${esc(food.n)}${tag}</span><span class="sub">${fmt(food.kcal)} קק״ל ל-100 ${baseShort(food)}${extra}</span></span>
    <span aria-hidden="true">＋</span></button>${deletable
      ? `<button class="del" data-del-food="${esc(food.id)}" aria-label="מחיקת ${esc(food.n)}" data-testid="del-food">🗑</button>` : ''}</li>`;
}

let searchTimer;
async function renderResults() {
  const q = $('#search').value.trim();
  const ul = $('#results');
  const empty = $('#results-empty');
  $('#add-tabs').hidden = !!q;
  let foods = [];
  if (q) {
    foods = matchFood(q, state.index, { limit: 40, boostIds: state.favIds });
    empty.textContent = 'לא נמצא. אפשר להוסיף מזון חדש או לסרוק ברקוד.';
  } else if (state.addTab === 'recent') {
    const recent = await recentFoods(20);
    foods = recent.map((e) => state.byId.get(e.foodId)).filter(Boolean);
    empty.textContent = 'עוד אין מזונות אחרונים. חפשו מזון כדי להתחיל.';
  } else if (state.addTab === 'fav') {
    foods = [...state.favIds].map((id) => state.byId.get(id)).filter(Boolean);
    empty.textContent = 'סמנו ⭐ על מזון כדי לשמור אותו כאן.';
  } else {
    foods = [...state.myFoods].sort((a, b) => a.n.localeCompare(b.n, 'he'));
    empty.textContent = 'מזונות שתוסיפו או תסרקו יופיעו כאן.';
  }
  const deletable = !q && state.addTab === 'mine';
  ul.innerHTML = foods.map((f) => foodRow(f, '', { deletable })).join('');
  empty.hidden = foods.length > 0;
}

// ---------- confirmItems: the one path into the diary ----------

/**
 * Opens the confirmation sheet for one or more foods and saves them to the diary.
 * items: [{ food, amount?, unit?, note? }]. Search, barcode and photo recognition all call this.
 * Resolves to the saved entry ids, or null when cancelled.
 */
export function confirmItems(items, { meal = state.addMeal, editId = null } = {}) {
  const sheet = $('#confirm-sheet');
  const box = $('#confirm-items');
  const known = (food, unit) => unit === 'g' || (food.m || []).some(([c]) => String(c) === String(unit));
  const rows = items.map((it) => {
    const note = it.note || '';
    const query = it.query || '';
    if (it.amount == null) return { food: it.food, note, query, ...defaultAmount(it.food) };
    // a unit this device's food data lacks (logged on a newer version): edit the same grams
    if (!known(it.food, it.unit || 'g')) return { food: it.food, note, query, amount: it.grams ?? it.amount, unit: 'g' };
    return { food: it.food, note, query, amount: it.amount, unit: it.unit || 'g' };
  });

  $('#confirm-title').textContent = editId ? 'עריכת פריט' : 'הוספה ליומן';
  $('#confirm-save').textContent = editId ? 'שמירה' : 'הוספה ליומן';
  $('#confirm-meal').innerHTML = MEALS.map((m) => `<option value="${m.id}" ${m.id === meal ? 'selected' : ''}>${m.label}</option>`).join('');

  const itemHtml = (r, i) => {
    const f = r.food;
    const opts = [['g', baseWord(f)], ...(f.m || []).map(([c, g]) => [String(c), `${unitLabel(f, c)} (${fmt(g)} ${baseShort(f)})`])];
    return `
      <div class="ci-head">
        <div class="ci-name">${esc(f.n)}<div class="ci-per">${fmt(f.kcal)} קק״ל · ח ${fmt1(f.p)} · פ ${fmt1(f.c)} · ש ${fmt1(f.f)} (ל-100 ${baseShort(f)})</div>${r.note ? `<div class="ci-note" data-testid="item-note">${esc(r.note)}</div>` : ''}</div>
        <button type="button" class="star" data-star="${esc(f.id)}" aria-pressed="${state.favIds.has(f.id)}" aria-label="מועדף" data-testid="star">★</button>
      </div>
      <div class="ci-amount">
        <input type="number" inputmode="decimal" min="0" step="any" value="${esc(r.amount)}" data-amount data-testid="amount" aria-label="כמות">
        <select data-unit data-testid="unit" aria-label="יחידה">${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === String(r.unit) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      </div>
      <div class="ci-kcal" data-kcal data-testid="item-kcal"></div>
      <button type="button" class="ci-swap" data-swap data-testid="swap">לא זה? החלפת מזון</button>
      <div class="ci-swap-panel" data-swap-panel hidden>
        <input type="search" data-swap-q data-testid="swap-search" placeholder="חיפוש המזון הנכון" autocomplete="off" enterkeyhint="search">
        <ul class="list compact" data-swap-results data-testid="swap-results"></ul>
      </div>`;
  };
  box.innerHTML = rows.map((r, i) => `<div class="confirm-item" data-i="${i}">${itemHtml(r, i)}</div>`).join('');

  // "not this?": search for the right food; the amount carries over in grams, shown in its natural unit
  const swapSearch = (i) => {
    const el = box.querySelector(`[data-i="${i}"]`);
    const q = el.querySelector('[data-swap-q]').value.trim();
    const found = q ? matchFood(q, state.index, { limit: 8, boostIds: state.favIds }) : [];
    el.querySelector('[data-swap-results]').innerHTML = found.length
      ? found.map((f) => `<li><button type="button" class="row" data-pick="${esc(f.id)}" data-testid="swap-result">
          <span class="grow"><span class="name">${esc(f.n)}</span><span class="sub">${fmt(f.kcal)} קק״ל ל-100 ${baseShort(f)}</span></span></button></li>`).join('')
      : (q ? '<li class="muted">לא נמצא. נסו מילה אחרת.</li>' : '');
  };
  const swapTo = (i, food) => {
    const r = rows[i];
    const grams = r.grams > 0 ? r.grams : 0;
    const d = defaultAmount(food);
    const unitG = d.unit === 'g' ? 0 : (food.m || []).find(([c]) => String(c) === String(d.unit))?.[1];
    let amount = d.amount;
    let unit = d.unit;
    if (grams && unitG) amount = Math.max(0.5, Math.round((grams / unitG) * 2) / 2);
    // rounding to half a unit must not change the portion much (30 g of rice is not half a 158 g cup):
    // the user corrected what it is, not how much, so keep the grams when the unit would drift > 15%
    if (grams && (!unitG || Math.abs(amount * unitG - grams) > 0.15 * grams)) { amount = Math.round(grams); unit = 'g'; }
    r.query ||= r.food.n;                    // the original name, kept across several replacements
    Object.assign(r, { food, amount, unit, note: `במקום: ${r.query}` });
    const el = box.querySelector(`[data-i="${i}"]`);
    el.innerHTML = itemHtml(r, i);
    compute();
  };

  const compute = () => {
    let total = 0;
    rows.forEach((r, i) => {
      const el = box.querySelector(`[data-i="${i}"]`);
      r.amount = Number(el.querySelector('[data-amount]').value) || 0;
      r.unit = el.querySelector('[data-unit]').value;
      r.grams = gramsFor(r.food, r.amount, r.unit);
      r.n = nutrientsFor(r.food, r.grams);
      el.querySelector('[data-kcal]').textContent = `${fmt(r.grams)} ${baseWord(r.food)} · ${fmt(r.n.kcal)} קק״ל`;
      total += r.n.kcal;
    });
    $('#confirm-total').textContent = fmt(total);
  };
  box.oninput = (ev) => {
    const q = ev.target.closest('[data-swap-q]');
    if (q) return swapSearch(Number(q.closest('[data-i]').dataset.i));
    compute();
  };
  box.onchange = (ev) => { if (!ev.target.closest('[data-swap-q]')) compute(); };
  box.onkeydown = (ev) => {
    if (ev.key !== 'Enter' || !ev.target.closest('[data-swap-q]')) return;
    ev.preventDefault();
    ev.target.closest('[data-i]').querySelector('[data-pick]')?.click();   // Enter picks the first result
  };
  box.onclick = async (ev) => {
    const swap = ev.target.closest('[data-swap]');
    if (swap) {
      const item = swap.closest('[data-i]');
      const i = Number(item.dataset.i);
      const panel = item.querySelector('[data-swap-panel]');
      panel.hidden = !panel.hidden;
      if (!panel.hidden) {
        const input = panel.querySelector('[data-swap-q]');
        if (!input.value) input.value = rows[i].query || rows[i].food.n.split(',')[0];
        swapSearch(i);
        input.focus();
        input.select();
      }
      return;
    }
    const pick = ev.target.closest('[data-pick]');
    if (pick) {
      const i = Number(pick.closest('[data-i]').dataset.i);
      const food = state.byId.get(pick.dataset.pick);
      if (food) swapTo(i, food);
      return;
    }
    const star = ev.target.closest('[data-star]');
    if (!star) return;
    const id = star.dataset.star;
    const food = state.byId.get(id) || rows.find((r) => r.food.id === id)?.food;
    if (state.favIds.has(id)) { await remove('favorites', id); state.favIds.delete(id); }
    else {
      if (food && !food.id.startsWith('t') && !state.myFoods.some((f) => f.id === food.id)) await put('myFoods', food);
      await put('favorites', { foodId: id }); state.favIds.add(id);
    }
    star.setAttribute('aria-pressed', state.favIds.has(id));
  };
  compute();

  return new Promise((resolve) => {
    sheet.onclose = async () => {
      if (sheet.returnValue !== 'save') {
        // a star toggled before cancelling still changed favourites / my foods: show it
        await refreshMyFoods();
        if (state.view === 'add') renderResults();
        return resolve(null);
      }
      compute();
      const mealId = $('#confirm-meal').value;
      const ids = [];
      // editing an amount down to 0 means "remove it", with undo, rather than silently doing nothing
      if (editId && rows.every((r) => r.grams <= 0)) {
        const prev = await db.log.get(editId);
        if (prev) {
          await remove('entries', editId);
          toast('הפריט נמחק', async () => { await put('entries', prev); renderToday(); if (state.view === 'chat') renderChat(); });
        }
        renderToday();
        return resolve([]);
      }
      if (!editId && rows.every((r) => r.grams <= 0)) { toast('לא נוסף: הכמות היא 0'); return resolve([]); }
      for (const r of rows) {
        if (r.grams <= 0) continue;
        if (!r.food.fromEntry && !String(r.food.id).startsWith('t') && !state.byId.has(r.food.id)) await put('myFoods', r.food);
        const entry = {
          date: state.date, meal: mealId, foodId: r.food.id, name: r.food.n,
          amount: r.amount, unit: r.unit, grams: r.grams, ...r.n, ts: Date.now(),
        };
        if (editId) {
          const prev = await db.log.get(editId);
          await put('entries', { ...prev, ...entry, id: editId, date: prev?.date ?? entry.date, ts: prev?.ts ?? entry.ts });
          ids.push(editId);
        } else ids.push((await put('entries', { id: newId(), ...entry })).id);
      }
      await refreshMyFoods();
      resolve(ids);
      if (!editId && ids.length) {
        const label = MEALS.find((m) => m.id === mealId).label;
        toast(`נוסף ל${label} ✓`);
        $('#search').value = '';
        show('today');
      } else renderToday();
    };
    sheet.returnValue = '';
    sheet.showModal();
  });
}
window.confirmItems = confirmItems;   // used by tests

// ---------- meal photo ----------

// Downscales before upload: Claude reads food fine at ~1.5 MP, and phone photos are 10+ MB.
// Photos live only in memory (canvas, data URL); nothing is written to storage or the gallery.
function toJpeg(source, width, height, maxSide = 1568) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  canvas.width = canvas.height = 0;   // free the pixels now
  return { dataUrl, base64: dataUrl.slice(dataUrl.indexOf(',') + 1) };
}

async function photoToJpeg(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); }
  catch (e) { throw new VisionError('bad_image', String(e?.message || e)); }   // HEIC, or too large for memory
  const img = toJpeg(bmp, bmp.width, bmp.height);
  bmp.close?.();
  return img;
}

// picking: picker or camera app open; ctrl: request in flight; confirming: recognized items awaiting
// approval; stream: the in-app camera; source: the current photo, kept in memory only for "try again"
// camGen: bumped on every stop, so a camera start that resolves late knows it is stale
const photo = { source: null, ctrl: null, picking: false, confirming: false, stream: null, camGen: 0, restartCamera: false, restarts: [] };

function stopCamera() {
  photo.camGen++;
  photo.stream?.getTracks().forEach((t) => t.stop());
  photo.stream = null;
  const video = $('#camera');
  video.srcObject = null;
  video.hidden = true;
  $('#shutter').hidden = true;
}

// In-app camera: the photo goes from the camera straight into memory, never through the camera
// app or the gallery. Falls back to the phone's camera app when the browser gives no camera access.
async function openCamera() {
  const sheet = $('#photo-sheet');
  stopCamera();                       // never two cameras; also invalidates any start still pending
  photo.ctrl?.abort();
  photo.ctrl = null;
  photo.restartCamera = false;
  forgetPhoto();
  resetPhotoSheet();
  const gen = photo.camGen;
  const stale = () => gen !== photo.camGen || !sheet.open;
  $('#photo-status').textContent = 'מפעיל מצלמה…';
  if (!sheet.open) sheet.showModal();
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('no camera API');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
    });
    if (stale()) { stream.getTracks().forEach((t) => t.stop()); return; }   // closed or restarted meanwhile
    photo.stream = stream;
    for (const t of stream.getVideoTracks()) t.addEventListener('ended', () => onCameraEnded(gen));
    const video = $('#camera');
    video.srcObject = stream;
    video.hidden = false;
    // wait for playback and the first frame, so the shutter always captures something; a camera with
    // no frames never settles play(), hence the deadline around both
    let timer;
    try {
      await Promise.race([
        video.play().then(() => video.videoWidth || new Promise((resolve) => video.addEventListener('loadeddata', resolve, { once: true }))),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('no frames')), 5000); }),
      ]);
    } finally { clearTimeout(timer); }
    if (stale()) return;
    $('#shutter').hidden = false;
    $('#photo-status').textContent = 'כוונו למנה ולחצו "צלם"';
  } catch (e) {
    if (stale()) return;
    stopCamera();
    // a permission answer gets the permission hint; anything else (no frames, camera busy) does not
    const denied = e?.name === 'NotAllowedError' || e?.name === 'SecurityError';
    $('#photo-status').textContent = denied
      ? 'אין הרשאה למצלמה. אפשר לאשר אותה בהגדרות הדפדפן, או לצלם באפליקציית המצלמה.'
      : 'המצלמה לא זמינה כרגע. אפשר לנסות שוב, או לצלם באפליקציית המצלמה.';
    showCameraFallback();
  }
}

function showCameraFallback() {
  $('#photo-actions').hidden = false;
  $('#photo-retry').hidden = false;   // "try again" restarts the in-app camera
  $('#camera-app').hidden = false;
  $('#camera-app-note').hidden = false;
}

function cameraUnavailable() {
  $('#photo-status').textContent = 'המצלמה לא זמינה כרגע. אפשר לנסות שוב, או לצלם באפליקציית המצלמה.';
  showCameraFallback();
}

// The system stopped the camera (another app took it, or the app was in the background).
function onCameraEnded(gen) {
  if (gen !== photo.camGen) return;   // we stopped it ourselves
  stopCamera();
  if (!$('#photo-sheet').open) return;
  // a camera that keeps dropping (another app holding it): stop retrying and offer the fallback
  const now = Date.now();
  photo.restarts = photo.restarts.filter((t) => now - t < 10000);
  if (photo.restarts.length >= 2) { cameraUnavailable(); return; }
  photo.restarts.push(now);
  if (document.visibilityState === 'visible') openCamera();
  else photo.restartCamera = true;    // restart when the app is back in front
}

function takePicture() {
  const video = $('#camera');
  const live = photo.stream?.getVideoTracks().some((t) => t.readyState === 'live');
  if (!live || !video.videoWidth) return;   // not streaming (yet), never send a frozen frame
  const img = toJpeg(video, video.videoWidth, video.videoHeight);
  stopCamera();
  analyzeMeal(img);
}

function resetPhotoSheet() {
  $('#photo-actions').hidden = true;
  $('#photo-settings').hidden = true;
  $('#camera-app').hidden = true;
  $('#camera-app-note').hidden = true;
  $('#photo-detail').hidden = true;
  $('#photo-preview').removeAttribute('src');
}

function forgetPhoto() {
  photo.source = null;
  $('#photo-preview').removeAttribute('src');
}

// Recognized items (photo or chat) to diary foods: the database food when one fits, else Claude's estimate.
function resolveItems(recognized) {
  return recognized.map((it, i) => {
    // the primary search term, then each alternative term Claude gave (8 results each, no duplicates)
    // what the person said the food is without ("אורז בלי שמן") holds for every search term
    const said = `${it.name} ${it.queries.join(' ')}`;
    const { without } = queryNegations(normalize(`${it.name} ${it.queries[0] || ''}`));
    const suffix = without.map((w) => ` ללא ${w}`).join('');
    const search = (q) => matchFood(q + suffix, state.index, { limit: 8, boostIds: state.favIds });
    const candidates = search(it.queries[0] || it.name);
    const seen = new Set(candidates.map((f) => f.id));
    const alternatives = it.queries.slice(1)
      .flatMap((q) => search(q).map((f, altRank) => ({ ...f, altQuery: q, altRank })))
      .filter((f) => !seen.has(f.id) && seen.add(f.id));
    // Claude names generic foods: a branded product only when nothing generic fits (or the brand was said)
    const { food, estimated } = pickFood(it, candidates, {
      alternatives, rank: (f) => foodPreference(f, said), makeId: () => 'a' + Date.now().toString(36) + i,
    });
    // an estimate far from the database's own reading of the same food is shown beside it
    const near = dbHint(it, food, candidates, alternatives, (f) => foodPreference(f, said));
    const hint = near ? `במאגר: ${near.n} (${fmt(near.kcal)} קק״ל ל-100 ג׳)` : '';
    const note = [estimated ? `זוהה: ${it.name} · ערכים משוערים (${fmt(food.kcal)} קק״ל ל-100 ג׳), לא נמצא במאגר`
      : (it.name !== food.n ? `זוהה: ${it.name}` : ''), hint].filter(Boolean).join(' · ');
    return { food, ...amountFor(it, food, unitLabel), note, hint, query: it.name, estimated, unsure: !!it.unsure, meal: it.meal, dayOffset: it.dayOffset };
  });
}

// source: a File (gallery / camera app) or an image already in memory ({ dataUrl, base64 })
async function analyzeMeal(source) {
  const sheet = $('#photo-sheet');
  const status = $('#photo-status');
  stopCamera();                       // a gallery pick while the camera was starting
  photo.restartCamera = false;
  photo.source = source;
  photo.ctrl?.abort();
  const ctrl = photo.ctrl = new AbortController();
  resetPhotoSheet();
  status.textContent = 'מזהה את המנה…';
  if (!sheet.open) sheet.showModal();
  try {
    const apiKey = await getSetting('apiKey', '');
    if (!apiKey) throw new VisionError('no_key', 'no key');
    const img = source instanceof Blob ? await photoToJpeg(source) : source;
    photo.source = img;   // retry reuses the small copy; the original file is released
    if (ctrl.signal.aborted) return;
    $('#photo-preview').src = img.dataUrl;
    const recognized = await analyzePhoto({ apiKey, imageBase64: img.base64, mediaType: 'image/jpeg', signal: ctrl.signal });
    if (ctrl.signal.aborted) return;
    if (!recognized.length) throw new VisionError('empty', 'no food');
    const items = resolveItems(recognized);
    photo.ctrl = null;
    sheet.close();
    forgetPhoto();
    photo.confirming = true;
    confirmItems(items).finally(() => { photo.confirming = false; });
  } catch (e) {
    if (ctrl.signal.aborted || e?.code === 'cancelled') return;
    photo.ctrl = null;
    const code = e instanceof VisionError ? e.code : 'api';
    console.warn('photo recognition failed', code, e?.message || e);
    status.textContent = ERROR_TEXT[code] || ERROR_TEXT.api;
    const detail = e?.detail || (code === 'api' ? String(e?.message || '') : '');
    $('#photo-detail').textContent = detail;
    $('#photo-detail').hidden = !detail;
    $('#photo-actions').hidden = false;
    $('#photo-retry').hidden = NO_RETRY.has(code);
    $('#photo-settings').hidden = !(code === 'no_key' || code === 'auth');
  }
}

function closePhoto() {
  photo.ctrl?.abort();
  photo.ctrl = null;
  stopCamera();
  $('#photo-sheet').close();
  forgetPhoto();
}

// ---------- chat: "הבוקר אכלתי פיתה עם גבינה לבנה" ----------

// The owner's choice: the chat logs straight to the diary (no confirm sheet); every reply shows what was
// saved, with undo and edit. Messages live in memory only: never stored, never synced.
// msgs: { id, me?, text?, ids?, undone?, error?, pending?, settings?, replaced?, replacedBy?, ask?, dropped?, saving? }
// ask: { items, doubts, now, targetId, missed }: items not saved yet because something about them is doubtful;
// the person saves them (data-chat-confirm), declines (data-chat-drop) or writes a correction.
// A correction ("לא שניצל מאמא עוף, שניצל ביתי") replaces what the latest reply logged: that reply gets
// replacedBy (the correction's id) and the correction keeps replaced { id, entries } so undo restores them.
const chat = { msgs: [], seq: 0, busy: 0, queue: Promise.resolve(), rec: null, listening: false, renderGen: 0, scrolledFor: '' };

// Saves resolved items as diary entries. Returns the saved entry ids in order, which of them carry
// Claude's own estimate, and the error that stopped saving partway, if any (what was saved stays saved).
async function saveItemsDirect(items, now = new Date()) {
  const today = isoDate(now);
  const out = { ids: [], estimated: [], hints: {}, error: null };
  try {
    for (const [i, r] of items.entries()) {
      const grams = gramsFor(r.food, r.amount, r.unit);
      if (!(grams > 0)) continue;
      // a food from outside the database (Claude's estimate) is kept, so the entry stays editable
      if (!String(r.food.id).startsWith('t') && !state.byId.has(r.food.id)) await put('myFoods', r.food);
      const entry = {
        id: newId(), date: r.date || addDays(today, r.dayOffset || 0), meal: r.meal || mealForHour(now.getHours()),
        foodId: r.food.id, name: r.food.n, amount: r.amount, unit: r.unit, grams, ...nutrientsFor(r.food, grams),
        ts: Date.now() + i,   // keeps the spoken order in the diary
      };
      const { id } = await put('entries', entry);
      out.ids.push(id);
      if (r.estimated) out.estimated.push(id);
      if (r.hint) out.hints[id] = r.hint;
    }
  } catch (e) { out.error = e; }
  await refreshMyFoods().catch(() => {});
  return out;
}

function dayWord(date) {
  const today = isoDate();
  if (date === today) return '';
  if (date === addDays(today, -1)) return 'אתמול';
  return new Date(date + 'T12:00:00').toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric' });
}

async function renderChat() {
  const gen = ++chat.renderGen;
  const log = $('#chat-log');
  const intro = log.firstElementChild.outerHTML;
  const all = chat.msgs.flatMap((m) => m.ids || []);
  const entries = new Map((await db.log.bulkGet(all)).filter(Boolean).map((e) => [e.id, e]));
  if (gen !== chat.renderGen) return;   // a newer render started meanwhile: it paints the current state
  const html = chat.msgs.map((m) => {
    if (m.me) return `<div class="bubble me" data-testid="chat-me">${esc(m.text)}</div>`;
    if (m.pending) return `<div class="bubble bot pending" data-testid="chat-pending">רושם…</div>`;
    if (m.error) {
      return `<div class="bubble bot error" data-testid="chat-error">${esc(m.text)}${m.settings
        ? `<div class="actions"><button type="button" class="btn secondary" data-chat-settings data-testid="chat-settings">להגדרות</button></div>` : ''}</div>`;
    }
    if (m.ask) {
      if (m.replacedBy) return `<div class="bubble bot" data-testid="chat-reply"><span class="undone">הוחלף בתיקון שלמטה</span></div>`;
      if (m.dropped) return `<div class="bubble bot" data-testid="chat-reply"><span class="undone">לא נרשם ליומן</span>${m.saving === false && m.text ? `<div>${esc(m.text)}</div>` : ''}</div>`;
      let total = 0;
      const items = m.ask.items.map((r, i) => {
        const grams = gramsFor(r.food, r.amount, r.unit);
        const kcal = nutrientsFor(r.food, grams).kcal;
        total += kcal;
        const w = askWhere(r, m.ask.now);
        const where = [MEALS.find((x) => x.id === w.meal)?.label, dayWord(w.date)].filter(Boolean).join(' · ');
        const amount = r.unit && r.unit !== 'g' ? `${r.amount} × ${unitLabel(r.food, r.unit)} (${fmt(grams)} ג׳)` : `${fmt(grams)} ג׳`;
        const why = m.ask.doubts[i];
        return `<li data-testid="chat-ask-item"><span class="grow"><span class="name">${esc(r.food.n)}</span>
          <span class="sub">${esc(amount)} · ${esc(where)}</span>${why ? `<span class="sub doubt" data-testid="chat-doubt">⚠ ${esc(why)}</span>` : ''}</span>
          <span class="kcal">${fmt(kcal)} קק״ל</span></li>`;
      }).join('');
      return `<div class="bubble bot" data-testid="chat-ask">
        <div>${m.text ? `${esc(m.text)} ` : ''}לפני שאני רושם, כדאי לבדוק:</div>
        <ul class="list compact">${items}</ul>
        <div class="total">סה״כ ${fmt(total)} קק״ל</div>
        <div class="actions">
          <button type="button" class="btn" data-chat-confirm="${m.id}" data-testid="chat-confirm" ${m.saving ? 'disabled' : ''}>לרשום</button>
          <button type="button" class="btn secondary" data-chat-drop="${m.id}" data-testid="chat-drop" ${m.saving ? 'disabled' : ''}>לא לרשום</button>
        </div>
        <div class="sub">אפשר גם לכתוב תיקון, למשל: "עלי גפן ממולאים"</div>
      </div>`;
    }
    const rows = (m.ids || []).map((id) => entries.get(id)).filter(Boolean);
    if (!m.ids?.length) return `<div class="bubble bot" data-testid="chat-reply">${esc(m.text)}</div>`;
    if (m.replacedBy && !m.undone) {
      return `<div class="bubble bot" data-testid="chat-reply"><span class="undone">הוחלף בתיקון שלמטה</span></div>`;
    }
    if (m.undone || !rows.length) {
      return `<div class="bubble bot" data-testid="chat-reply"><span class="undone">${m.undone ? 'בוטל, לא נרשם ליומן' : 'הפריטים כבר לא ביומן'}</span></div>`;
    }
    const total = rows.reduce((s, e) => s + (Number(e.kcal) || 0), 0);
    const items = rows.map((e) => {
      const where = [MEALS.find((x) => x.id === e.meal)?.label, dayWord(e.date)].filter(Boolean).join(' · ');
      // an estimate shows its calories per 100 g (and the database's reading when far from it), so an
      // implausible one is easy to spot
      // (the food's own value: the entry's kcal is rounded, which skews small amounts)
      const per100 = Math.round(Number(state.byId.get(e.foodId)?.kcal)
        || (e.grams > 0 ? (Number(e.kcal) || 0) / e.grams * 100 : 0));
      const est = (m.estimated?.includes(e.id) ? ` · ערכים משוערים${per100 > 0 ? ` (${fmt(per100)} קק״ל ל-100 ג׳)` : ''}` : '')
        + (m.hints?.[e.id] ? ` · ${m.hints[e.id]}` : '');
      return `<li data-testid="chat-item"><span class="grow"><span class="name">${esc(e.name)}</span>
        <span class="sub">${esc(amountText(e))} · ${esc(where)}${est}</span></span>
        <span class="kcal">${fmt(e.kcal)} קק״ל</span>
        <button type="button" class="link-btn" data-chat-edit="${esc(e.id)}" data-testid="chat-edit">עריכה</button></li>`;
    }).join('');
    return `<div class="bubble bot" data-testid="chat-reply">
      <div>${m.text ? esc(m.text) : m.replaced ? 'עודכן ביומן ✓' : 'נרשם ליומן ✓'}</div>
      <ul class="list compact">${items}</ul>
      <div class="total">סה״כ ${fmt(total)} קק״ל</div>
      <div class="actions"><button type="button" class="btn secondary" data-chat-undo="${m.id}" data-testid="chat-undo">ביטול</button></div>
    </div>`;
  }).join('');
  log.innerHTML = intro + html;
  // the screen-reader status speaks only the newest reply, not the whole chat again
  const last = chat.msgs[chat.msgs.length - 1];
  const status = last && !last.me && !last.pending ? log.lastElementChild.innerText.replace(/\s+/g, ' ').replace(/ עריכה/g, '').trim() : '';
  if (status && $('#chat-status').textContent !== status) $('#chat-status').textContent = status;
  // the log's bottom padding keeps the newest bubble above the composer and the nav
  // (only when something new arrived, so undo or edit higher up does not jump the screen)
  const key = `${last?.id}:${!!last?.pending}`;
  if (state.view === 'chat' && key !== chat.scrolledFor) {
    chat.scrolledFor = key;
    window.scrollTo(0, document.documentElement.scrollHeight);
  }
}

// Messages are handled one at a time, in the order sent: a second message while the first is still
// being logged waits its turn (people send in pieces: "פיתה", then "וגם קפה"). Nothing is ever aborted,
// so a request that was paid for is always logged and always answered.
// A short yes or no typed (or said) in answer to the question that waits right now: answered here,
// like its buttons, without asking Claude ("כן" must not become a second question or a second entry).
const CHAT_YES = /^(כן|כן כן|נכון|בדיוק|תרשום|רשום|תרשמי|לרשום|אישור|מאשר|מאשרת|בסדר|סבבה|אוקיי|אוקי|ok|okay|yes|👍)[.!]*$/i;
const CHAT_NO = /^(לא|ממש לא|אל תרשום|אל תרשמי|לא לרשום|ביטול|תבטל|תבטלי|no)[.!]*$/i;

function waitingAsk() {
  if (chat.msgs.some((m) => m.pending)) return null;
  const last = [...chat.msgs].reverse().find((m) => !m.me);
  return last?.ask && !last.replacedBy && !last.dropped && !last.saving ? last : null;
}

function sendChat(text) {
  text = String(text || '').trim();
  if (!text) return chat.queue;
  stopListening();
  $('#chat-input').value = '';
  fitChatInput();
  const ask = waitingAsk();
  const answer = ask && (CHAT_YES.test(text) ? 'yes' : CHAT_NO.test(text) ? 'no' : '');
  if (answer) {
    // the answer shows below the question, which turns into the outcome (the history Claude sees pairs
    // each message with the reply right after it, so the question stays with the message it answers)
    chat.msgs.push({ id: ++chat.seq, me: true, text });
    if (answer === 'yes') return confirmChat(ask.id);
    dropChat(ask.id);
    return chat.queue;
  }
  chat.msgs.push({ id: ++chat.seq, me: true, text });
  const pending = { id: ++chat.seq, pending: true };
  chat.msgs.push(pending);
  chat.busy++;
  renderChat();
  chat.queue = chat.queue.then(() => logChat(text, pending)).finally(() => { chat.busy--; });
  return chat.queue;
}

// What the chat said before `pending`, for Claude to read a follow-up or a correction: each earlier
// message with what of it is still in the diary. `last` is the reply a correction can replace: the latest
// one that logged something, while some of it is still in the diary (only that part is shown, and only
// that part is replaced). Claude sees which message that is.
async function chatContext(pending) {
  const before = chat.msgs.slice(0, chat.msgs.indexOf(pending));
  const all = before.flatMap((m) => m.ids || []);
  const live = new Map((await db.log.bulkGet(all)).filter(Boolean).map((e) => [e.id, e]));
  const history = [];
  let last = null;
  let lastAt = -1;
  for (const [i, m] of before.entries()) {
    if (!m.me) continue;
    const reply = before[i + 1];
    if (!reply || reply.me || reply.pending) continue;
    if (reply.ask) {
      // waiting for the person: listed like logged items, and the latest one can be corrected
      const status = reply.replacedBy ? 'replaced' : reply.dropped ? 'dropped' : 'pending';
      history.push({
        text: m.text,
        status,
        logged: status === 'pending' ? reply.ask.items.map((r) => {
          const w = askWhere(r, reply.ask.now);
          return { name: r.food.n, grams: gramsFor(r.food, r.amount, r.unit), where: [MEALS.find((x) => x.id === w.meal)?.label, dayWord(w.date)].filter(Boolean).join(' ') };
        }) : null,
      });
      last = status === 'pending' ? reply : null;
      lastAt = history.length - 1;
      continue;
    }
    const rows = (reply.ids || []).map((id) => live.get(id)).filter(Boolean);
    const status = !reply.ids?.length ? 'none' : reply.undone ? 'undone' : reply.replacedBy ? 'replaced' : rows.length ? 'logged' : 'deleted';
    history.push({
      text: m.text,
      status,
      logged: status === 'logged' ? rows.map((e) => ({
        name: e.name, grams: e.grams, where: [MEALS.find((x) => x.id === e.meal)?.label, dayWord(e.date)].filter(Boolean).join(' '),
      })) : null,
    });
    if (reply.ids?.length) { last = status === 'logged' ? reply : null; lastAt = history.length - 1; }
  }
  if (last) history[lastAt].correctable = true;
  const shown = history.slice(-4);
  // a correctable message that scrolled out of what Claude sees cannot be corrected
  if (last && !shown.some((h) => h.correctable)) last = null;
  return { history: shown, last };
}

// Where an item not saved yet will go: its own meal and day, else the meal for the time of the message.
function askWhere(r, now) {
  const at = new Date(now);
  return { meal: r.meal || mealForHour(at.getHours()), date: r.date || addDays(isoDate(at), r.dayOffset || 0) };
}

// Why an item is worth a look before saving ('' when it is not). The owner's choice: the chat saves
// straight away and asks only when something is doubtful: Claude's own estimate (not in the database),
// a database reading far from the chosen food, Claude was unsure what the food is, or counted pieces
// that each weigh almost nothing, for a food this person has never logged (5 "vine leaves" at 5 g each).
async function chatDoubts(items) {
  const ids = [...new Set(items.map((r) => r.food.id))];
  const known = new Set((await db.log.where('foodId').anyOf(ids).toArray()).map((e) => e.foodId));
  return items.map((r) => {
    const grams = gramsFor(r.food, r.amount, r.unit);
    const kcal = nutrientsFor(r.food, grams).kcal;
    const why = [];
    if (r.estimated) why.push(`לא נמצא במאגר: ערכים משוערים (${fmt(r.food.kcal)} קק״ל ל-100 ג׳)`);
    if (r.hint) why.push(r.hint);
    if (r.unsure) why.push('לא היה ברור לגמרי מה בדיוק אכלת');
    // counted pieces that each weigh almost nothing ("5 עלי גפן" at 5 g each, 18 kcal), for a food this
    // person has never logged; not a spoon or a cup (those measure), and not vegetables or condiments
    // weighed in grams, which are light by nature
    const label = r.unit && r.unit !== 'g' ? normalize(unitLabel(r.food, r.unit)) : '';
    const perPiece = label && r.amount > 0 ? grams / r.amount : 0;
    if (label && !/(^| )(כפ|כפית|כוס|ספל|קורט|מצקת|מנה)( |$)/.test(label) && perPiece > 0 && perPiece < 10
      && kcal < 30 && !known.has(r.food.id)) why.push(`כל יחידה שוקלת רק ${fmt1(perPiece)} ג׳ (${fmt(kcal)} קק״ל בסך הכל)`);
    return why.join(' · ');
  });
}

// Saves a chat message's items and, for a correction, removes what the target reply logged. Returns the
// fields of the reply message. missed: the message was a correction but there is nothing to replace.
async function commitChat(id, items, now, target, reply, missed) {
  let saved = null;
  let replaced = null;
  try {
    saved = await saveItemsDirect(items, now);
    if (saved.error) throw saved.error;
    if (!saved.ids.length) return { text: reply || CHAT_ERROR_TEXT.empty };
    // the new items are saved, so what they replace can go. Claimed before any wait, so an undo tapped
    // meanwhile sees it; kept even if removing stops partway, so undo can still bring all of it back.
    if (target && !target.undone && !target.replacedBy) {
      target.replacedBy = id;
      replaced = { id: target.id, entries: [] };
      replaced.entries = (await db.log.bulkGet(target.ids)).filter(Boolean);
      for (const e of replaced.entries) await remove('entries', e.id);
    }
    const note = missed && !replaced ? 'לא מצאתי רישום קודם לתקן, אז זה נרשם כחדש.' : '';
    return { text: [reply, note].filter(Boolean).join(' '), ids: saved.ids, estimated: saved.estimated, hints: saved.hints, replaced };
  } catch (e) {
    console.warn('chat saving failed', e?.message || e);
    // part of the message was already saved when storage failed: show it, with its undo
    if (saved?.ids.length) return { text: CHAT_ERROR_TEXT.partial, ids: saved.ids, estimated: saved.estimated, hints: saved.hints, replaced };
    return { error: true, text: CHAT_ERROR_TEXT.local };
  }
}

async function logChat(text, pending) {
  const finish = (m) => {
    const at = chat.msgs.indexOf(pending);
    if (at >= 0) chat.msgs.splice(at, 1, { id: pending.id, ...m });
    renderChat();
    if (state.view === 'today') renderToday();
  };
  try {
    const apiKey = await getSetting('apiKey', '');
    if (!apiKey) throw new VisionError('no_key', 'no key');
    const now = new Date();
    const { history, last } = await chatContext(pending);
    const { items: recognized, reply, replacesPrevious } = await analyzeText({ apiKey, text, now, history });
    if (!recognized.length) { finish({ text: reply || CHAT_ERROR_TEXT.empty }); return; }
    const items = resolveItems(recognized);
    // the message it corrects: a saved reply, or one still waiting for confirmation (which is simply
    // superseded, and passes on the saved reply it was itself going to replace)
    let target = replacesPrevious && last && !last.undone && !last.replacedBy && !last.dropped ? last : null;
    let prev = [];
    // (the waiting question is marked replaced only once the correction is saved or asks in turn)
    let supersede = null;
    if (target?.ask) {
      prev = target.ask.items.map((r) => ({ name: r.food.n, ...askWhere(r, target.ask.now) }));
      supersede = target;
      const before = target.ask.targetId && chat.msgs.find((x) => x.id === target.ask.targetId);
      target = before && before.ids?.length && !before.undone && !before.replacedBy ? before : null;
    } else if (target) prev = (await db.log.bulkGet(target.ids)).filter(Boolean);
    if (prev.length) {
      // a correction keeps the meal and day of what it corrects, unless it names others: each corrected
      // item takes after the replaced one it is most like by name, else the same position
      const stems = (t) => new Set(normalize(t).split(' ').filter((w) => w.length >= 2).map((w) => w.slice(0, 3)));
      for (const [i, r] of items.entries()) {
        const mine = stems(`${r.query} ${r.food.n}`);
        const overlap = (e) => [...stems(e.name)].filter((x) => mine.has(x)).length;
        const was = prev.reduce((a, e) => (overlap(e) > overlap(a) ? e : a), prev[Math.min(i, prev.length - 1)]);
        if (!r.meal) r.meal = was.meal;
        if (!r.dayOffset) r.date = was.date;
      }
    }
    const missed = replacesPrevious && !target && !prev.length;
    const doubts = await chatDoubts(items);
    const replaceAsk = (m) => {
      if (supersede && !supersede.replacedBy && !supersede.dropped && (m.ask || m.ids?.length)) {
        supersede.replacedBy = pending.id;
        m.replacedAsk = supersede.id;
      }
      return m;
    };
    if (doubts.some(Boolean)) {
      finish(replaceAsk({ text: reply, ask: { items, doubts, now: now.getTime(), targetId: target?.id ?? null, missed } }));
      return;
    }
    finish(replaceAsk(await commitChat(pending.id, items, now, target, reply, missed)));
  } catch (e) {
    const code = e instanceof VisionError ? e.code : 'local';
    console.warn('chat logging failed', code, e?.message || e);
    finish({ error: true, text: CHAT_ERROR_TEXT[code] || CHAT_ERROR_TEXT.api, settings: code === 'no_key' || code === 'auth' });
  }
}

// The person saves items that waited for confirmation: in the chat's queue, after any message still
// being logged, and only if no correction replaced them meanwhile.
function confirmChat(id) {
  const m = chat.msgs.find((x) => x.id === id);
  if (!m?.ask || m.replacedBy || m.dropped || m.saving) return chat.queue;
  m.saving = true;
  renderChat();
  chat.busy++;
  chat.queue = chat.queue.then(async () => {
    if (m.replacedBy || m.dropped) return;
    const { items, now, targetId, missed } = m.ask;
    const t = targetId && chat.msgs.find((x) => x.id === targetId);
    // what this question was going to correct was corrected by another message meanwhile: saving it too
    // would log the food twice
    if (t?.replacedBy && t.replacedBy !== m.id) {
      m.saving = false;
      m.dropped = true;
      m.text = 'לא נרשם: הרישום שרצית לתקן כבר תוקן בהודעה אחרת.';
      renderChat();
      return;
    }
    const target = t && t.ids?.length && !t.undone && !t.replacedBy ? t : null;
    const result = await commitChat(m.id, items, new Date(now), target, m.text, missed || (!!targetId && !target));
    const at = chat.msgs.indexOf(m);
    if (at >= 0) chat.msgs.splice(at, 1, { id: m.id, ...result });
    renderChat();
    if (state.view === 'today') renderToday();
  }).finally(() => { chat.busy--; });
  return chat.queue;
}

function dropChat(id) {
  const m = chat.msgs.find((x) => x.id === id);
  if (!m?.ask || m.replacedBy || m.saving) return;
  m.dropped = true;
  renderChat();
}

// Flags change before any wait, so a correction being saved meanwhile sees them (and vice versa).
async function undoChat(id) {
  const m = chat.msgs.find((x) => x.id === id);
  if (!m?.ids || m.undone || m.replacedBy) return;
  m.undone = true;
  // undoing a correction of a waiting question brings the question back
  const asked = m.replacedAsk && chat.msgs.find((x) => x.id === m.replacedAsk);
  if (asked?.replacedBy === m.id) asked.replacedBy = null;
  // undoing a correction brings back what it replaced
  const old = m.replaced && chat.msgs.find((x) => x.id === m.replaced.id);
  if (old?.replacedBy === m.id) old.replacedBy = null;
  else if (old) return void (m.undone = false);
  const prev = (await db.log.bulkGet(m.ids)).filter(Boolean);
  for (const e of prev) await remove('entries', e.id);
  if (old) for (const e of m.replaced.entries) await put('entries', e);
  await renderChat();
  if (state.view === 'today') renderToday();
  toast('בוטל', async () => {
    if (!m.undone) return;
    // the restored message was corrected again, or undone, meanwhile: redoing this one would duplicate
    if (old && (old.replacedBy || old.undone)) return;
    // likewise the restored question, once answered or corrected again
    if (asked && (asked.replacedBy || asked.dropped || !asked.ask)) return;
    if (asked) asked.replacedBy = m.id;
    m.undone = false;
    if (old) old.replacedBy = m.id;
    for (const e of prev) await put('entries', e);
    if (old) {
      // what is in the diary now, so an edit made meanwhile comes back with the next undo
      const now = (await db.log.bulkGet(m.replaced.entries.map((e) => e.id))).filter(Boolean);
      for (const e of now) await remove('entries', e.id);
      m.replaced.entries = now;
    }
    renderChat();
    if (state.view === 'today') renderToday();
  });
}

async function editChatEntry(id) {
  const entry = await db.log.get(id);
  if (!entry) { renderChat(); return; }
  await editEntry(entry);
  renderChat();
}

function fitChatInput() {
  const el = $('#chat-input');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight + 2, 120) + 'px';
  // the log's bottom padding and the toast follow the composer's real height
  const h = $('#chat-form').offsetHeight;
  if (h) document.documentElement.style.setProperty('--composer-h', h + 'px');
}

// Voice: the browser's speech recognition (on Chrome for Android, Google's speech service turns the
// speech into text; the app never records or keeps audio). Hidden where the browser has none.
const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;

function stopListening() {
  if (!chat.rec) return;
  const rec = chat.rec;
  chat.rec = null;
  try { rec.abort(); } catch { /* already stopped */ }
  setListening(false);
}

function setListening(on) {
  chat.listening = on;
  const mic = $('#chat-mic');
  mic.setAttribute('aria-pressed', String(on));
  mic.setAttribute('aria-label', on ? 'עצירת ההקלטה' : 'הקלטה');
  $('#chat-input').placeholder = on ? 'מקשיב…' : 'מה אכלת?';
}

function toggleListening() {
  if (chat.rec) { stopListening(); return; }
  const rec = new Speech();
  rec.lang = 'he-IL';
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  const input = $('#chat-input');
  const before = input.value.trim();
  let heard = '';
  chat.rec = rec;
  rec.onresult = (ev) => {
    if (chat.rec !== rec) return;
    heard = [...ev.results].map((r) => r[0]?.transcript || '').join('').trim();
    input.value = [before, heard].filter(Boolean).join(' ');
    fitChatInput();
    if (ev.results[ev.results.length - 1]?.isFinal) {
      chat.rec = null;
      setListening(false);
      sendChat(input.value);
    }
  };
  rec.onerror = (ev) => {
    if (chat.rec !== rec) return;
    chat.rec = null;
    setListening(false);
    const text = ev.error === 'not-allowed' || ev.error === 'service-not-allowed'
      ? 'אין הרשאה למיקרופון. אפשר לאשר אותה בהגדרות הדפדפן, או להקליד.'
      : ev.error === 'no-speech' ? 'לא שמעתי כלום. נסו שוב, או הקלידו.'
        : ev.error === 'network' ? 'זיהוי הדיבור צריך חיבור לאינטרנט.'
          : ev.error === 'aborted' ? '' : 'זיהוי הדיבור לא הצליח. נסו שוב, או הקלידו.';
    if (text) toast(text);
  };
  rec.onend = () => {
    if (chat.rec !== rec) return;
    chat.rec = null;
    setListening(false);
    if (heard) sendChat(input.value);   // ended without a final result: send what was heard
  };
  try { rec.start(); setListening(true); }
  catch { chat.rec = null; setListening(false); toast('זיהוי הדיבור לא הצליח. נסו שוב, או הקלידו.'); }
}

// ---------- barcode ----------

// scanGen: bumped on every stop, so a camera start that finishes after the sheet closed is undone
let scanner = null;
let scanGen = 0;
async function openScanner() {
  const sheet = $('#scan-sheet');
  $('#barcode-input').value = '';
  $('#scan-status').textContent = 'כוונו את המצלמה לברקוד';
  sheet.showModal();
  if (!window.Html5Qrcode || !navigator.mediaDevices?.getUserMedia) {
    $('#scan-status').textContent = 'אין גישה למצלמה. אפשר להקליד את מספר הברקוד.';
    return;
  }
  const gen = ++scanGen;
  let instance;
  try {
    const F = window.Html5QrcodeSupportedFormats;
    instance = new window.Html5Qrcode('scanner', {
      formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128],
      experimentalFeatures: { useBarCodeDetectorIfSupported: true },
      verbose: false,
    });
    await instance.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 260, height: 140 } },
      (code) => { if (gen === scanGen) { stopScanner(); handleBarcode(code); } }, () => {});
    if (gen !== scanGen || !sheet.open) {   // closed (or a code typed) while the camera was starting
      try { await instance.stop(); instance.clear(); } catch { /* not running */ }
      return;
    }
    scanner = instance;
  } catch {
    if (gen === scanGen && sheet.open) $('#scan-status').textContent = 'המצלמה לא זמינה. אפשר להקליד את מספר הברקוד.';
  }
}

async function stopScanner() {
  scanGen++;
  const s = scanner;
  scanner = null;
  if (s) {
    try { await s.stop(); s.clear(); } catch { /* already stopped */ }
  }
}

async function closeScanner() {
  await stopScanner();
  $('#scan-sheet').close();
}

async function handleBarcode(code) {
  code = String(code).replace(/\D/g, '');
  if (!code) return;
  $('#scan-status').textContent = `מחפש ${code}…`;
  let food = state.myFoods.find((f) => f.barcode === code) || null;
  let offline = false;
  if (!food) {
    try { food = await lookupBarcode(code); }
    catch { offline = true; }
  }
  await closeScanner();
  if (food) {
    await put('myFoods', food);
    await refreshMyFoods();
    confirmItems([{ food }]);
  } else {
    openFoodForm({ barcode: code, hint: offline
      ? 'אין חיבור למאגר הברקודים כרגע. אפשר להזין את הערכים מהתווית, והמוצר יישמר אצלכם לפעם הבאה.'
      : 'המוצר לא נמצא במאגר. הזינו את הערכים מהתווית, והוא יישמר אצלכם לפעם הבאה.' });
  }
}

// ---------- new food form ----------

// Quick unit presets for the new-food form. A size is suggested only for liquids, where a cup is
// 240 ml whatever the drink. For solids every size depends on the food (a cup of flour is ~120 g,
// of rice ~190 g), so the user writes the weight and the app never invents a portion.
const UNIT_PRESETS = {
  solid: [['פרוסה'], ['יחידה'], ['מנה'], ['כף'], ['כפית'], ['כוס']],
  liquid: [['כוס', 240], ['פחית', 330], ['בקבוק', 500], ['כף', 15], ['כפית', 5], ['מנה']],
};
const ffState = { kind: 'solid' };

function setFoodKind(kind) {
  ffState.kind = kind;
  for (const b of $$('#ff-kind button')) b.setAttribute('aria-pressed', String(b.dataset.kind === kind));
  const per = kind === 'liquid' ? 'מ״ל' : 'גרם';
  $('#ff-kcal-label').textContent = `קלוריות ל-100 ${per}`;
  if (!ffState.customHint) $('#food-form-hint').textContent = `הערכים מופיעים על גב האריזה, בטבלה "ל-100 ${per}".`;
  for (const s of $$('#ff-units .unit-suffix')) s.textContent = kind === 'liquid' ? 'מ״ל' : 'גרם';
  for (const i of $$('#ff-units [data-unit-g]')) i.placeholder = kind === 'liquid' ? 'מ״ל' : 'גרם';
  $('#ff-unit-chips').innerHTML = UNIT_PRESETS[kind].map(([n, g]) =>
    `<button type="button" class="chip" data-preset="${esc(n)}" data-g="${g || ''}" data-testid="unit-preset">${esc(n)}${g ? ` <small>${g}</small>` : ''}</button>`).join('');
}

function addUnitRow(name = '', grams = '') {
  const per = ffState.kind === 'liquid' ? 'מ״ל' : 'גרם';
  const row = document.createElement('div');
  row.className = 'unit-row';
  row.dataset.testid = 'unit-row';
  row.innerHTML = `<input data-unit-name data-testid="unit-name" placeholder="שם, למשל: פרוסה" maxlength="30" aria-label="שם היחידה">
    <input type="number" inputmode="decimal" step="any" min="0" data-unit-g data-testid="unit-g" placeholder="${per}" aria-label="כמה היחידה שוקלת">
    <span class="unit-suffix">${per}</span>
    <button type="button" class="icon-btn" data-remove aria-label="הסרת יחידה">✕</button>`;
  row.querySelector('[data-unit-name]').value = name;
  row.querySelector('[data-unit-g]').value = grams;
  $('#ff-units').append(row);
  return row;
}

function openFoodForm({ barcode = '', name = '', hint } = {}) {
  const form = $('#food-form');
  form.reset();
  $('#ff-units').innerHTML = '';
  ffState.customHint = !!hint;
  $('#ff-barcode').value = barcode;
  $('#ff-name').value = name;
  $('#food-form-hint').textContent = hint || '';
  setFoodKind('solid');
  $('#food-sheet').showModal();
}

function readUnitRows() {
  const units = [];
  for (const row of $$('#ff-units .unit-row')) {
    const nameEl = row.querySelector('[data-unit-name]');
    const gEl = row.querySelector('[data-unit-g]');
    const name = nameEl.value.trim();
    const g = Number(gEl.value) || 0;
    nameEl.setCustomValidity(''); gEl.setCustomValidity('');
    if (!name && !gEl.value) continue;                       // empty row: ignore
    if (!name) { nameEl.setCustomValidity('כתבו שם ליחידה'); nameEl.reportValidity(); return null; }
    if (g <= 0) { gEl.setCustomValidity('כתבו כמה היחידה שוקלת'); gEl.reportValidity(); return null; }
    if (units.some((u) => u.name === name)) { nameEl.setCustomValidity('כבר יש יחידה בשם הזה'); nameEl.reportValidity(); return null; }
    units.push({ name, g });
  }
  return units;
}

async function saveFoodForm(ev) {
  ev.preventDefault();
  const units = readUnitRows();
  if (!units) return;
  const num = (id) => Number($(id).value) || 0;
  const barcode = $('#ff-barcode').value.replace(/\D/g, '');
  const food = {
    id: barcode ? 'b' + barcode : 'u' + Date.now().toString(36),
    n: $('#ff-name').value.trim(),
    kcal: num('#ff-kcal'), p: num('#ff-p'), c: num('#ff-c'), f: num('#ff-f'),
    m: [],
    src: 'user',
  };
  if (barcode) food.barcode = barcode;
  if (ffState.kind === 'liquid') food.liquid = true;
  units.forEach((u, i) => food.m.push([`u${i + 1}`, u.g, u.name]));
  await put('myFoods', food);
  await refreshMyFoods();
  $('#food-sheet').close();
  confirmItems([{ food }]);
}

// ---------- history ----------

function chartColors() {
  const cs = getComputedStyle(document.documentElement);
  return { brand: cs.getPropertyValue('--brand').trim(), muted: cs.getPropertyValue('--muted').trim(), line: cs.getPropertyValue('--line').trim(), warn: cs.getPropertyValue('--warn').trim() };
}

function drawChart(key, canvas, config) {
  if (!window.Chart) return;
  state.charts[key]?.destroy();
  state.charts[key] = new window.Chart(canvas, config);
}

async function renderHistory() {
  const days = [];
  for (let i = state.range - 1; i >= 0; i--) days.push(addDays(isoDate(), -i));
  const entries = await db.log.where('date').between(days[0], days[days.length - 1], true, true).toArray();
  const totals = days.map((d) => sumEntries(entries.filter((e) => e.date === d)).kcal);
  const logged = totals.filter((t) => t > 0);
  const avg = logged.length ? logged.reduce((a, b) => a + b, 0) / logged.length : 0;
  $('#avg-line').textContent = logged.length ? `ממוצע בימים עם רישום: ${fmt(avg)} קק״ל (${logged.length} ימים)` : 'עוד אין נתונים לתקופה הזו.';

  for (const b of $$('#range-picker button')) b.setAttribute('aria-pressed', String(Number(b.dataset.range) === state.range));
  const c = chartColors();
  const labels = days.map((d) => { const [, m, dd] = d.split('-'); return `${Number(dd)}/${Number(m)}`; });
  drawChart('kcal', $('#kcal-chart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { type: 'bar', label: 'קלוריות', data: totals, backgroundColor: totals.map((t) => (t > state.target ? c.warn : c.brand)), borderRadius: 4 },
        { type: 'line', label: 'יעד', data: days.map(() => state.target), borderColor: c.muted, borderDash: [5, 4], pointRadius: 0, borderWidth: 1.5 },
      ],
    },
    options: {
      maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { rtl: true } },
      scales: { x: { reverse: true, grid: { display: false }, ticks: { color: c.muted, maxRotation: 0, autoSkip: true } }, y: { beginAtZero: true, grid: { color: c.line }, ticks: { color: c.muted } } },
    },
  });

  const recentDays = [...new Set((await db.log.orderBy('date').reverse().limit(2000).toArray()).map((e) => e.date))].slice(0, 30);
  $('#day-list').innerHTML = recentDays.length ? (await Promise.all(recentDays.map(async (d) => {
    const t = sumEntries(await db.log.where('date').equals(d).toArray()).kcal;
    const label = new Date(d + 'T12:00:00').toLocaleDateString('he-IL', { weekday: 'short', day: 'numeric', month: 'numeric' });
    return `<li><button class="row" data-goto="${esc(d)}"><span class="grow">${esc(label)}</span><span class="kcal">${fmt(t)} קק״ל</span></button></li>`;
  }))).join('') : '<li class="muted">אין עדיין ימים קודמים</li>';

  await renderWeights();
}

async function renderWeights() {
  const ws = await db.weights.orderBy('date').toArray();
  const last = ws.slice(-60);
  const c = chartColors();
  $('#weight-chart').parentElement.hidden = ws.length < 1;
  drawChart('weight', $('#weight-chart'), {
    type: 'line',
    data: { labels: last.map((w) => { const [, m, d] = w.date.split('-'); return `${Number(d)}/${Number(m)}`; }), datasets: [{ label: 'משקל', data: last.map((w) => w.kg), borderColor: c.brand, backgroundColor: c.brand, tension: 0.25 }] },
    options: { maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } }, scales: { x: { reverse: true, ticks: { color: c.muted } }, y: { grid: { color: c.line }, ticks: { color: c.muted } } } },
  });
  $('#weight-list').innerHTML = ws.slice(-5).reverse().map((w) => `
    <li data-testid="weight-row"><span class="grow">${new Date(w.date + 'T12:00:00').toLocaleDateString('he-IL')}</span><span class="kcal">${esc(w.kg)} ק״ג</span>
    <button class="del" data-del-weight="${esc(w.date)}" aria-label="מחיקת שקילה">🗑</button></li>`).join('');
}

// ---------- settings ----------

// fields the user changed since Settings opened: a render that finishes late must not overwrite them
const settingsTouched = new Set();

async function renderSettings() {
  settingsTouched.clear();
  // read everything first, then fill the form in one go, skipping what the user already changed
  const mode = await getSetting('targetMode', 'calc');
  const p = (await getSetting('profile', null)) || { sex: 'female', age: '', height: '', weight: '', activity: 1.375, goal: -500 };
  const latestWeigh = await db.weights.orderBy('date').last();
  const manualTarget = (await getSetting('manualTarget', null)) || state.target;
  const apiKey = (await getSetting('apiKey', '')) || '';
  const set = (id, value) => { if (!settingsTouched.has(id)) $(`#${id}`).value = value; };
  if (!$('#p-activity').options.length) $('#p-activity').innerHTML = ACTIVITY.map((a) => `<option value="${a.id}">${a.label}</option>`).join('');
  if (!$('#p-goal').options.length) $('#p-goal').innerHTML = GOALS.map((g) => `<option value="${g.id}">${g.label}</option>`).join('');
  set('p-sex', p.sex); set('p-age', p.age); set('p-height', p.height);
  // the current weight is the latest weigh-in (History); remember what was shown, so saving other
  // settings does not record it again as today's weigh-in
  const shownWeight = String(latestWeigh?.kg ?? p.weight ?? '');
  set('p-weight', shownWeight);
  $('#p-weight').dataset.shown = shownWeight;
  set('p-activity', String(p.activity)); set('p-goal', String(p.goal));
  set('manual-target', manualTarget);
  set('api-key', apiKey);
  savedApiKey = apiKey;
  $('#app-version').textContent = APP_VERSION;
  $('#app-built').textContent = builtText(BUILD.builtAt);
  renderSyncStatus();
  if (!settingsTouched.has('target-mode')) setTargetMode(mode);
  updateCalcPreview();
}

function setTargetMode(mode) {
  for (const b of $$('#target-mode button')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  $('#manual-fields').hidden = mode !== 'manual';
  $('#calc-fields').hidden = mode !== 'calc';
  for (const el of $$('#calc-fields input')) el.required = mode === 'calc';
  $('#manual-target').required = mode === 'manual';
}

function readProfile() {
  return {
    sex: $('#p-sex').value, age: Number($('#p-age').value), height: Number($('#p-height').value),
    weight: Number($('#p-weight').value), activity: Number($('#p-activity').value), goal: Number($('#p-goal').value),
  };
}

function updateCalcPreview() {
  const p = readProfile();
  if (!(p.age && p.height && p.weight)) { $('#calc-result').textContent = 'מלאו גיל, גובה ומשקל כדי לחשב יעד.'; return; }
  const t = targetInfo(p);
  const note = t.clamped === 'low'
    ? ` (החישוב יצא ${fmt(t.raw)}; זה המינימום המומלץ בלי ליווי רפואי)`
    : t.clamped === 'high' ? ` (החישוב יצא ${fmt(t.raw)}; כדאי לבדוק את הנתונים)` : '';
  $('#calc-result').textContent = `היעד המחושב: ${fmt(t.target)} קק״ל ליום${note}`;
}

async function saveTarget(ev) {
  ev.preventDefault();
  const mode = $('#target-mode button[aria-pressed="true"]').dataset.mode;
  await setSetting('targetMode', mode);
  if (mode === 'manual') await setSetting('manualTarget', Number($('#manual-target').value));
  else {
    const p = readProfile();
    // the weight field shows the latest weigh-in. Edited: it is today's weigh-in and the new profile
    // weight. Not edited: the profile keeps its own weight and the weigh-ins stay as they are, so
    // saving other settings never changes them, and deleting a mistyped weigh-in later still falls
    // back to the right value (Codex P2 / review)
    const prev = await getSetting('profile', null);
    const edited = $('#p-weight').value !== ($('#p-weight').dataset.shown ?? '');
    if (!edited && prev?.weight > 0) p.weight = prev.weight;
    await setSetting('profile', p);
    const latest = await db.weights.orderBy('date').last();
    if (p.weight > 0 && (!latest || (edited && latest.kg !== p.weight))) await put('weights', { date: isoDate(), kg: p.weight });
    $('#p-weight').dataset.shown = $('#p-weight').value;
  }
  await loadTarget();
  toast(`היעד נשמר: ${fmt(state.target)} קק״ל`);
}

async function exportBackup() {
  const data = makeBackup(await dumpAll());
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `kalorit-backup-${isoDate()}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function importBackup(file) {
  try {
    const data = parseBackup(await file.text());
    // with sync on, take in other phones' changes first: restore then knows about their deletes
    let offlineNote = '';
    if ((await sync.status()).code) {
      toast('מסנכרן לפני השחזור…');
      const res = await sync.syncNow();
      if (res?.error) offlineNote = ' אין חיבור לענן כרגע: פריטים שנמחקו בטלפון אחר אולי לא יחזרו.';
    }
    if (!confirm(`לשחזר גיבוי עם ${data.entries.length} רישומים? הפריטים מהגיבוי יחזרו, גם כאלה שנמחקו אחריו. שום דבר לא יימחק: מה שנוסף או נערך אחרי הגיבוי יישאר.${offlineNote}`)) return;
    await restoreAll(data);
    await refreshMyFoods();
    await loadTarget();
    toast('הגיבוי שוחזר ✓');
    renderSettings();
  } catch (err) {
    toast('שגיאה בייבוא: ' + err.message);
  }
}

// The calculated target follows the latest remaining weigh-in: after saving, deleting (e.g. a typo
// of 170 instead of 70) or undoing one, it matches what is left (Codex P2). See loadTarget.
const followLatestWeight = () => loadTarget();

// ---------- events ----------

function editEntry(entry) {
  // a food this phone does not know (synced from another phone, or removed): rebuild it from the
  // entry's own values, so the entry can still be edited in grams
  const per100 = (v) => (entry.grams > 0 ? Math.round(((Number(v) || 0) / entry.grams) * 1000) / 10 : 0);
  const food = state.byId.get(entry.foodId) || {
    id: entry.foodId, n: String(entry.name ?? ''), kcal: per100(entry.kcal), p: per100(entry.p), c: per100(entry.c), f: per100(entry.f), m: [],
    fromEntry: true,   // only for this edit: never saved back as a food (it may have been deleted on purpose)
  };
  return confirmItems([{ food, amount: entry.amount ?? entry.grams, unit: entry.unit, grams: entry.grams }], { meal: entry.meal, editId: entry.id });
}

function bind() {
  $('.bottomnav').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (!b) return;
    // "add" from the bottom bar suggests the meal for now; a meal card's "+" picks its own meal
    if (b.dataset.view === 'add' && state.date === isoDate()) state.addMeal = mealForHour(new Date().getHours());
    show(b.dataset.view);
  });
  $('#day-prev').onclick = () => setDate(addDays(state.date, -1));
  $('#day-next').onclick = () => { if (state.date < isoDate()) setDate(addDays(state.date, 1)); };
  $('#date-label').onclick = () => setDate(isoDate());

  $('#meals').addEventListener('click', async (e) => {
    const add = e.target.closest('[data-add-meal]');
    const del = e.target.closest('[data-del]');
    const edit = e.target.closest('[data-edit]');
    if (add) { state.addMeal = add.dataset.addMeal; show('add'); $('#search').focus(); }
    else if (del) {
      const entry = await db.log.get(del.dataset.del);
      if (!entry) { renderToday(); return; }   // already removed (e.g. by a sync from another phone)
      await remove('entries', entry.id);
      renderToday();
      toast('הפריט נמחק', async () => { await put('entries', entry); renderToday(); });
    } else if (edit) {
      const entry = await db.log.get(edit.dataset.edit);
      if (!entry) { renderToday(); return; }
      editEntry(entry);
    }
  });
  $('#quick').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-quick]');
    if (chip) quickAdd(chip.dataset.quick);
  });

  $('#meal-picker').addEventListener('click', (e) => {
    const b = e.target.closest('[data-meal]');
    if (b) { state.addMeal = b.dataset.meal; renderMealPicker(); }
  });
  $('#search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderResults, 80); });
  $('#add-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    state.addTab = b.dataset.tab;
    for (const t of $$('#add-tabs button')) t.setAttribute('aria-selected', String(t === b));
    renderResults();
  });
  $('#results').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del-food]');
    if (del) {
      // diary entries keep their own numbers, so removing a saved food never changes the diary
      const id = del.dataset.delFood;
      const food = state.myFoods.find((f) => f.id === id);
      const wasFav = state.favIds.has(id);
      await remove('myFoods', id);
      if (wasFav) await remove('favorites', id);
      await refreshMyFoods();
      renderResults();
      if (food) toast('המזון נמחק', async () => { await put('myFoods', food); if (wasFav) await put('favorites', { foodId: id }); await refreshMyFoods(); renderResults(); });
      return;
    }
    const b = e.target.closest('[data-food]');
    const food = b && state.byId.get(b.dataset.food);
    if (food) confirmItems([{ food }]);
  });

  $('#chat-form').onsubmit = (e) => { e.preventDefault(); sendChat($('#chat-input').value); };
  $('#chat-input').addEventListener('input', fitChatInput);
  $('#chat-input').addEventListener('keydown', (e) => {
    // Enter sends; Shift+Enter is a new line
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat(e.target.value); }
  });
  $('#chat-mic').hidden = !Speech;
  $('#chat-mic').onclick = toggleListening;
  $('#chat-log').addEventListener('click', (e) => {
    const undo = e.target.closest('[data-chat-undo]');
    const edit = e.target.closest('[data-chat-edit]');
    const confirm = e.target.closest('[data-chat-confirm]');
    const drop = e.target.closest('[data-chat-drop]');
    if (confirm) confirmChat(Number(confirm.dataset.chatConfirm));
    else if (drop) dropChat(Number(drop.dataset.chatDrop));
    else if (undo) undoChat(Number(undo.dataset.chatUndo));
    else if (edit) editChatEntry(edit.dataset.chatEdit);
    else if (e.target.closest('[data-chat-settings]')) { show('settings'); $('#experimental').open = true; $('#api-key').focus(); }
  });

  $('#open-camera').onclick = () => { photo.restarts = []; openCamera(); };
  $('#shutter').onclick = takePicture;
  for (const input of [$('#photo-input'), $('#camera-input')]) {
    input.onclick = () => { photo.picking = true; };
    input.addEventListener('cancel', () => { photo.picking = false; });
    input.onchange = (e) => { photo.picking = false; const f = e.target.files[0]; e.target.value = ''; if (f) analyzeMeal(f); };
  }
  $('#photo-close').onclick = closePhoto;
  $('#photo-sheet').addEventListener('cancel', (e) => { e.preventDefault(); closePhoto(); });
  // however the sheet closes (✕, back gesture without a cancel event, success): camera off, photo gone
  $('#photo-sheet').addEventListener('close', () => {
    if ($('#photo-sheet').open) return;   // the event arrives late: the sheet was already reopened for a new photo
    photo.ctrl?.abort();
    photo.ctrl = null;
    photo.restartCamera = false;
    stopCamera();
    forgetPhoto();
  });
  $('#photo-retry').onclick = () => {
    if (photo.source) analyzeMeal(photo.source);
    else { photo.restarts = []; openCamera(); }   // the camera fallback screen
  };
  $('#photo-settings').onclick = () => { closePhoto(); show('settings'); $('#experimental').open = true; $('#api-key').focus(); };
  $('#open-scan').onclick = openScanner;
  $('#scan-close').onclick = closeScanner;
  $('#scan-sheet').addEventListener('cancel', (e) => { e.preventDefault(); closeScanner(); });
  // however the sheet closes (back gesture without a cancel event included), the camera goes off
  $('#scan-sheet').addEventListener('close', () => { stopScanner(); });
  // ✕ is a plain button, so Enter in the amount field submits with "save", not with ✕
  $('#confirm-close').onclick = () => $('#confirm-sheet').close('cancel');
  $('#barcode-form').onsubmit = (e) => { e.preventDefault(); handleBarcode($('#barcode-input').value); };
  $('#open-new-food').onclick = () => openFoodForm({ name: $('#search').value.trim() });
  $('#food-close').onclick = () => $('#food-sheet').close();
  $('#food-form').onsubmit = saveFoodForm;
  $('#ff-kind').addEventListener('click', (e) => { const b = e.target.closest('[data-kind]'); if (b) setFoodKind(b.dataset.kind); });
  $('#ff-add-unit').onclick = () => addUnitRow().querySelector('[data-unit-name]').focus();
  $('#ff-unit-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-preset]');
    if (!b) return;
    const existing = $$('#ff-units [data-unit-name]').find((i) => i.value.trim() === b.dataset.preset);
    const row = existing?.closest('.unit-row') || addUnitRow(b.dataset.preset, b.dataset.g);
    row.querySelector('[data-unit-g]').focus();
  });
  $('#ff-units').addEventListener('click', (e) => { if (e.target.closest('[data-remove]')) e.target.closest('.unit-row').remove(); });
  // any edit may resolve an error flagged on another row (a renamed duplicate, a row emptied)
  $('#ff-units').addEventListener('input', () => { for (const i of $$('#ff-units input')) i.setCustomValidity(''); });

  $('#range-picker').addEventListener('click', (e) => {
    const b = e.target.closest('[data-range]');
    if (b) { state.range = Number(b.dataset.range); renderHistory(); }
  });
  $('#day-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-goto]');
    if (b) { state.date = b.dataset.goto; show('today'); }
  });
  $('#weight-form').onsubmit = async (e) => {
    e.preventDefault();
    const kg = Number($('#weight-input').value);
    if (!(kg > 0)) return;
    await put('weights', { date: isoDate(), kg });
    $('#weight-input').value = '';
    await followLatestWeight();
    toast(`נשמר: ${kg} ק״ג`);
    renderWeights();
  };
  $('#weight-list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del-weight]');
    if (!b) return;
    const prev = await db.weights.get(b.dataset.delWeight);
    await remove('weights', b.dataset.delWeight);
    await followLatestWeight();
    renderWeights();
    if (prev) toast('השקילה נמחקה', async () => { await put('weights', prev); await followLatestWeight(); renderWeights(); });
  });

  $('#target-mode').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (b) setTargetMode(b.dataset.mode);
  });
  $('#calc-fields').addEventListener('input', updateCalcPreview);
  $('#target-form').onsubmit = saveTarget;
  for (const ev of ['input', 'change']) $('#view-settings').addEventListener(ev, (e) => { if (e.target.id) settingsTouched.add(e.target.id); });
  $('#target-mode').addEventListener('click', () => settingsTouched.add('target-mode'), true);
  $('#export-btn').onclick = exportBackup;
  $('#import-input').onchange = (e) => { const f = e.target.files[0]; if (f) importBackup(f); e.target.value = ''; };
  $('#install-btn').onclick = installApp;
  // the key is shown only while looking at it: hidden again after saving or closing the section
  const hideKey = () => { $('#api-key').classList.add('masked'); $('#api-key-show').textContent = 'הצגה'; $('#api-key-show').setAttribute('aria-pressed', 'false'); };
  $('#experimental').addEventListener('toggle', hideKey);
  $('#api-key-save').addEventListener('click', hideKey);
  $('#api-key-show').onclick = () => {
    const shown = $('#api-key').classList.toggle('masked') === false;
    $('#api-key-show').textContent = shown ? 'הסתרה' : 'הצגה';
    $('#api-key-show').setAttribute('aria-pressed', String(shown));
  };
  $('#check-update').onclick = () => updater.check({ manual: true });
  $('#sync-create').onclick = () => connectSync(sync.generateCode());
  $('#sync-join-open').onclick = () => { $('#sync-join-form').hidden = false; $('#sync-join-code').focus(); };
  $('#sync-join-form').onsubmit = async (e) => {
    e.preventDefault();
    try { await connectSync($('#sync-join-code').value); $('#sync-join-form').hidden = true; $('#sync-join-code').value = ''; }
    catch (err) { toast(err.message); }
  };
  $('#sync-share').onclick = shareCode;
  $('#sync-now').onclick = async () => {
    const res = await sync.syncNow();
    toast(res?.error ? 'הסנכרון נכשל, ננסה שוב' : 'סונכרן ✓');
  };
  $('#sync-disconnect').onclick = async () => {
    if (!confirm('לנתק את המכשיר מהסנכרון? הנתונים יישארו בטלפון ובענן. כדי להתחבר שוב תצטרכו את הקוד.')) return;
    await sync.disconnect();
    toast('המכשיר נותק מהסנכרון');
  };
  window.addEventListener('online', () => sync.syncNow());

  $('#api-key-save').onclick = async () => {
    const key = $('#api-key').value.trim();
    await setSetting('apiKey', key);
    savedApiKey = key;
    toast('המפתח נשמר בטלפון');
  };

  // a new day while the app stays open
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') { stopListening(); updater.onHidden(); return; }
    if (rollDay()) { renderDate(); if (state.view === 'add') renderMealPicker(); }
    // back from the camera or picker: the change event (if any) fires right after this
    if (photo.picking) setTimeout(() => { photo.picking = false; }, 3000);
    // the system may stop the camera while the app is in the background: start it again
    if (photo.restartCamera || (photo.stream && photo.stream.getVideoTracks().every((t) => t.readyState === 'ended'))) {
      photo.restartCamera = false;
      if ($('#photo-sheet').open && !photo.ctrl) openCamera(); else stopCamera();
    }
    if (state.view === 'today') renderToday();
    if (state.view === 'chat') renderChat();
    sync.syncNow();
    updater.check();
  });
}

async function start() {
  // the update path runs first and on its own: if anything below breaks after a partial
  // deploy, the app can still fetch the version that fixes it
  try {
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
    }
    updater.announce();
    updater.check();
  } catch { /* never block startup */ }

  bind();
  // ask the browser not to clear this app's data under storage pressure (it holds the only copy
  // when sync is off)
  try { navigator.storage?.persist?.().catch(() => {}); } catch { /* not supported */ }
  window.addEventListener('popstate', (e) => show(e.state?.view || 'today', { fromHistory: true }));
  await Promise.all([loadFoods(), loadTarget()]);
  document.body.dataset.ready = '1';
  show('today');
  renderSyncStatus();
  sync.syncNow();
}

start();
