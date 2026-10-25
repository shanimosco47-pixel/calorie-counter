import { db, getSetting, setSetting, dumpAll, restoreAll, recentFoods } from './lib/db.js';
import { buildIndex, matchFood } from './lib/match.js';
import {
  MEALS, ACTIVITY, GOALS, gramsFor, nutrientsFor, sumEntries, totalsByMeal, dailyTarget,
  macroTargets, mealForHour, isoDate, addDays, makeBackup, parseBackup,
} from './lib/calc.js';
import { lookupBarcode } from './lib/off.js';

export const APP_VERSION = '1.0.0';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Math.round(n).toLocaleString('he-IL');

const state = {
  date: isoDate(),
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
  if (mode === 'manual' && manual) state.target = manual;
  else if (profile) state.target = dailyTarget(profile);
  else state.target = 2000;
}

function unitLabel(food, code) {
  if (code === 'g') return 'גרם';
  const m = (food.m || []).find(([c]) => String(c) === String(code));
  if (m && m[2]) return m[2];
  if (code === 'serving') return 'מנה (לפי היצרן)';
  return state.units[code] || String(code);
}

function amountText(e) {
  if (!e.unit || e.unit === 'g') return `${fmt(e.grams)} גרם`;
  const food = state.byId.get(e.foodId) || { m: [] };
  return `${e.amount} × ${unitLabel(food, e.unit)} (${fmt(e.grams)} ג׳)`;
}

function defaultAmount(food) {
  // Prefer a "medium/standard" household measure so the first suggestion is realistic.
  const prefer = ['u1', '103', '100', '500', '502', '800', '802', '1226', 'serving', '300', '200'];
  for (const code of prefer) if ((food.m || []).some(([c]) => String(c) === code)) return { amount: 1, unit: code };
  return { amount: 100, unit: 'g' };
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

// ---------- navigation ----------

function show(view) {
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
  const entries = await db.entries.where('date').equals(state.date).sortBy('ts');
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
          <button class="row grow" data-edit="${e.id}">
            <span class="grow"><span class="name">${esc(e.name)}</span><span class="sub">${esc(amountText(e))}</span></span>
            <span class="kcal">${fmt(e.kcal)}</span>
          </button>
          <button class="del" data-del="${e.id}" aria-label="מחיקה">🗑</button>
        </li>`).join('')}</ul>` : ''}
    </div>`;
  }).join('');

  await renderQuick();
}

async function renderQuick() {
  const recent = await recentFoods(10);
  $('#quick-card').hidden = recent.length === 0;
  $('#quick').innerHTML = recent.map((e) => `
    <button class="chip" data-quick="${e.id}" data-testid="quick-chip" title="${esc(e.name)}">
      ${esc(e.name.split(',')[0])} <small>${fmt(e.kcal)}</small>
    </button>`).join('');
}

async function quickAdd(entryId) {
  const src = await db.entries.get(entryId);
  if (!src) return;
  const meal = state.date === isoDate() ? mealForHour(new Date().getHours()) : src.meal;
  const { id, ...copy } = src;
  const newId = await db.entries.add({ ...copy, date: state.date, meal, ts: Date.now() });
  await renderToday();
  const mealLabel = MEALS.find((m) => m.id === meal).label;
  toast(`נוסף ל${mealLabel}: ${src.name.split(',')[0]}`, async () => { await db.entries.delete(newId); renderToday(); });
}

// ---------- add / search ----------

function renderMealPicker() {
  $('#meal-picker').innerHTML = MEALS.map((m) => `
    <button role="radio" aria-checked="${m.id === state.addMeal}" data-meal="${m.id}" data-testid="pick-${m.id}">${m.label}</button>`).join('');
}

function foodRow(food, extra = '') {
  const tag = food.src === 'off' ? '<span class="tag">ברקוד</span>' : food.id.startsWith('u') ? '<span class="tag">שלי</span>' : '';
  return `<li><button class="row" data-food="${esc(food.id)}" data-testid="result">
    <span class="grow"><span class="name">${esc(food.n)}${tag}</span><span class="sub">${fmt(food.kcal)} קק״ל ל-100 ג׳${extra}</span></span>
    <span aria-hidden="true">＋</span></button></li>`;
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
  ul.innerHTML = foods.map((f) => foodRow(f)).join('');
  empty.hidden = foods.length > 0;
}

// ---------- confirmItems: the one path into the diary ----------

/**
 * Opens the confirmation sheet for one or more foods and saves them to the diary.
 * items: [{ food, amount?, unit? }]. Search, barcode and (later) photo recognition all call this.
 * Resolves to the saved entry ids, or null when cancelled.
 */
export function confirmItems(items, { meal = state.addMeal, editId = null } = {}) {
  const sheet = $('#confirm-sheet');
  const box = $('#confirm-items');
  const rows = items.map((it) => ({ food: it.food, ...defaultAmount(it.food), ...(it.amount != null ? { amount: it.amount, unit: it.unit || 'g' } : {}) }));

  $('#confirm-title').textContent = editId ? 'עריכת פריט' : 'הוספה ליומן';
  $('#confirm-save').textContent = editId ? 'שמירה' : 'הוספה ליומן';
  $('#confirm-meal').innerHTML = MEALS.map((m) => `<option value="${m.id}" ${m.id === meal ? 'selected' : ''}>${m.label}</option>`).join('');

  box.innerHTML = rows.map((r, i) => {
    const f = r.food;
    const opts = [['g', 'גרם'], ...(f.m || []).map(([c, g]) => [String(c), `${unitLabel(f, c)} (${fmt(g)} ג׳)`])];
    return `<div class="confirm-item" data-i="${i}">
      <div class="ci-head">
        <div class="ci-name">${esc(f.n)}<div class="ci-per">${fmt(f.kcal)} קק״ל · ח ${f.p} · פ ${f.c} · ש ${f.f} (ל-100 ג׳)</div></div>
        <button type="button" class="star" data-star="${esc(f.id)}" aria-pressed="${state.favIds.has(f.id)}" aria-label="מועדף" data-testid="star">★</button>
      </div>
      <div class="ci-amount">
        <input type="number" inputmode="decimal" min="0" step="any" value="${r.amount}" data-amount data-testid="amount" aria-label="כמות">
        <select data-unit data-testid="unit" aria-label="יחידה">${opts.map(([v, l]) => `<option value="${v}" ${v === String(r.unit) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      </div>
      <div class="ci-kcal" data-kcal data-testid="item-kcal"></div>
    </div>`;
  }).join('');

  const compute = () => {
    let total = 0;
    rows.forEach((r, i) => {
      const el = box.querySelector(`[data-i="${i}"]`);
      r.amount = Number(el.querySelector('[data-amount]').value) || 0;
      r.unit = el.querySelector('[data-unit]').value;
      r.grams = gramsFor(r.food, r.amount, r.unit);
      r.n = nutrientsFor(r.food, r.grams);
      el.querySelector('[data-kcal]').textContent = `${fmt(r.grams)} גרם · ${fmt(r.n.kcal)} קק״ל`;
      total += r.n.kcal;
    });
    $('#confirm-total').textContent = fmt(total);
  };
  box.oninput = compute;
  box.onchange = compute;
  box.onclick = async (ev) => {
    const star = ev.target.closest('[data-star]');
    if (!star) return;
    const id = star.dataset.star;
    const food = state.byId.get(id) || rows.find((r) => r.food.id === id)?.food;
    if (state.favIds.has(id)) { await db.favorites.delete(id); state.favIds.delete(id); }
    else {
      if (food && !food.id.startsWith('t')) await db.myFoods.put(food);
      await db.favorites.put({ foodId: id }); state.favIds.add(id);
    }
    star.setAttribute('aria-pressed', state.favIds.has(id));
  };
  compute();

  return new Promise((resolve) => {
    sheet.onclose = async () => {
      if (sheet.returnValue !== 'save') return resolve(null);
      compute();
      const mealId = $('#confirm-meal').value;
      const ids = [];
      for (const r of rows) {
        if (r.grams <= 0) continue;
        if (!r.food.id.startsWith('t') && !state.byId.has(r.food.id)) await db.myFoods.put(r.food);
        const entry = {
          date: state.date, meal: mealId, foodId: r.food.id, name: r.food.n,
          amount: r.amount, unit: r.unit, grams: r.grams, ...r.n, ts: Date.now(),
        };
        if (editId) { await db.entries.update(editId, entry); ids.push(editId); }
        else ids.push(await db.entries.add(entry));
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
window.confirmItems = confirmItems;   // used by tests and by round-2 photo recognition

// ---------- barcode ----------

let scanner = null;
async function openScanner() {
  const sheet = $('#scan-sheet');
  $('#barcode-input').value = '';
  $('#scan-status').textContent = 'כוונו את המצלמה לברקוד';
  sheet.showModal();
  if (!window.Html5Qrcode || !navigator.mediaDevices?.getUserMedia) {
    $('#scan-status').textContent = 'אין גישה למצלמה. אפשר להקליד את מספר הברקוד.';
    return;
  }
  try {
    const F = window.Html5QrcodeSupportedFormats;
    scanner = new window.Html5Qrcode('scanner', {
      formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128],
      experimentalFeatures: { useBarCodeDetectorIfSupported: true },
      verbose: false,
    });
    await scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 260, height: 140 } },
      (code) => { stopScanner(); handleBarcode(code); }, () => {});
  } catch {
    $('#scan-status').textContent = 'המצלמה לא זמינה. אפשר להקליד את מספר הברקוד.';
    scanner = null;
  }
}

async function stopScanner() {
  if (scanner) {
    try { await scanner.stop(); scanner.clear(); } catch { /* already stopped */ }
    scanner = null;
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
  if (!food) {
    try { food = await lookupBarcode(code); }
    catch { $('#scan-status').textContent = 'אין חיבור למאגר הברקודים. אפשר להזין את המוצר ידנית.'; }
  }
  await closeScanner();
  if (food) {
    await db.myFoods.put(food);
    await refreshMyFoods();
    confirmItems([{ food }]);
  } else {
    openFoodForm({ barcode: code, hint: 'המוצר לא נמצא במאגר. הזינו את הערכים מהתווית, והוא יישמר אצלכם לפעם הבאה.' });
  }
}

// ---------- new food form ----------

function openFoodForm({ barcode = '', name = '', hint } = {}) {
  const form = $('#food-form');
  form.reset();
  $('#ff-barcode').value = barcode;
  $('#ff-name').value = name;
  $('#food-form-hint').textContent = hint || 'הערכים מופיעים על גב האריזה, בטבלה "ל-100 גרם".';
  $('#food-sheet').showModal();
}

async function saveFoodForm(ev) {
  ev.preventDefault();
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
  const unitName = $('#ff-unit').value.trim();
  const unitG = num('#ff-unit-g');
  if (unitName && unitG > 0) food.m.push(['u1', unitG, unitName]);
  await db.myFoods.put(food);
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
  const entries = await db.entries.where('date').between(days[0], days[days.length - 1], true, true).toArray();
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

  const recentDays = [...new Set((await db.entries.orderBy('date').reverse().limit(2000).toArray()).map((e) => e.date))].slice(0, 30);
  $('#day-list').innerHTML = recentDays.length ? (await Promise.all(recentDays.map(async (d) => {
    const t = sumEntries(await db.entries.where('date').equals(d).toArray()).kcal;
    const label = new Date(d + 'T12:00:00').toLocaleDateString('he-IL', { weekday: 'short', day: 'numeric', month: 'numeric' });
    return `<li><button class="row" data-goto="${d}"><span class="grow">${label}</span><span class="kcal">${fmt(t)} קק״ל</span></button></li>`;
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
    <li data-testid="weight-row"><span class="grow">${new Date(w.date + 'T12:00:00').toLocaleDateString('he-IL')}</span><span class="kcal">${w.kg} ק״ג</span>
    <button class="del" data-del-weight="${w.date}" aria-label="מחיקה">🗑</button></li>`).join('');
}

// ---------- settings ----------

async function renderSettings() {
  const mode = await getSetting('targetMode', 'calc');
  const p = (await getSetting('profile', null)) || { sex: 'female', age: '', height: '', weight: '', activity: 1.375, goal: -500 };
  $('#p-activity').innerHTML = ACTIVITY.map((a) => `<option value="${a.id}">${a.label}</option>`).join('');
  $('#p-goal').innerHTML = GOALS.map((g) => `<option value="${g.id}">${g.label}</option>`).join('');
  $('#p-sex').value = p.sex; $('#p-age').value = p.age; $('#p-height').value = p.height; $('#p-weight').value = p.weight;
  $('#p-activity').value = String(p.activity); $('#p-goal').value = String(p.goal);
  $('#manual-target').value = (await getSetting('manualTarget', null)) || state.target;
  $('#api-key').value = (await getSetting('apiKey', '')) || '';
  $('#app-version').textContent = APP_VERSION;
  setTargetMode(mode);
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
  $('#calc-result').textContent = p.age && p.height && p.weight
    ? `היעד המחושב: ${fmt(dailyTarget(p))} קק״ל ליום`
    : 'מלאו גיל, גובה ומשקל כדי לחשב יעד.';
}

async function saveTarget(ev) {
  ev.preventDefault();
  const mode = $('#target-mode button[aria-pressed="true"]').dataset.mode;
  await setSetting('targetMode', mode);
  if (mode === 'manual') await setSetting('manualTarget', Number($('#manual-target').value));
  else {
    const p = readProfile();
    await setSetting('profile', p);
    if (!(await db.weights.count())) await db.weights.put({ date: isoDate(), kg: p.weight });
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
    if (!confirm(`לשחזר גיבוי עם ${data.entries.length} רישומים? הנתונים הנוכחיים יוחלפו.`)) return;
    await restoreAll(data);
    await refreshMyFoods();
    await loadTarget();
    toast('הגיבוי שוחזר ✓');
    renderSettings();
  } catch (err) {
    toast('שגיאה בייבוא: ' + err.message);
  }
}

// ---------- events ----------

function bind() {
  $('.bottomnav').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (b) show(b.dataset.view);
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
      const entry = await db.entries.get(Number(del.dataset.del));
      await db.entries.delete(entry.id);
      renderToday();
      toast('הפריט נמחק', async () => { await db.entries.put(entry); renderToday(); });
    } else if (edit) {
      const entry = await db.entries.get(Number(edit.dataset.edit));
      const food = state.byId.get(entry.foodId);
      if (food) confirmItems([{ food, amount: entry.amount, unit: entry.unit }], { meal: entry.meal, editId: entry.id });
    }
  });
  $('#quick').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-quick]');
    if (chip) quickAdd(Number(chip.dataset.quick));
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
  $('#results').addEventListener('click', (e) => {
    const b = e.target.closest('[data-food]');
    const food = b && state.byId.get(b.dataset.food);
    if (food) confirmItems([{ food }]);
  });

  $('#open-scan').onclick = openScanner;
  $('#scan-close').onclick = closeScanner;
  $('#scan-sheet').addEventListener('cancel', (e) => { e.preventDefault(); closeScanner(); });
  $('#barcode-form').onsubmit = (e) => { e.preventDefault(); handleBarcode($('#barcode-input').value); };
  $('#open-new-food').onclick = () => openFoodForm({ name: $('#search').value.trim() });
  $('#food-close').onclick = () => $('#food-sheet').close();
  $('#food-form').onsubmit = saveFoodForm;

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
    await db.weights.put({ date: isoDate(), kg });
    $('#weight-input').value = '';
    toast(`נשמר: ${kg} ק״ג`);
    renderWeights();
  };
  $('#weight-list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del-weight]');
    if (b) { await db.weights.delete(b.dataset.delWeight); renderWeights(); }
  });

  $('#target-mode').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (b) setTargetMode(b.dataset.mode);
  });
  $('#calc-fields').addEventListener('input', updateCalcPreview);
  $('#target-form').onsubmit = saveTarget;
  $('#export-btn').onclick = exportBackup;
  $('#import-input').onchange = (e) => { const f = e.target.files[0]; if (f) importBackup(f); e.target.value = ''; };
  $('#api-key-save').onclick = async () => { await setSetting('apiKey', $('#api-key').value.trim()); toast('המפתח נשמר בטלפון'); };

  // a new day while the app stays open
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.view === 'today') renderToday();
  });
}

async function start() {
  bind();
  await Promise.all([loadFoods(), loadTarget()]);
  document.body.dataset.ready = '1';
  show('today');
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

start();
