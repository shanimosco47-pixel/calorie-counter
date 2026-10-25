// Nutrition math. Pure functions, shared by the app and the unit tests.

export const MEALS = [
  { id: 'breakfast', label: 'בוקר' },
  { id: 'lunch', label: 'צהריים' },
  { id: 'dinner', label: 'ערב' },
  { id: 'snack', label: 'נשנושים' },
];

export const ACTIVITY = [
  { id: 1.2, label: 'יושבני (כמעט בלי פעילות)' },
  { id: 1.375, label: 'קל (1-3 אימונים בשבוע)' },
  { id: 1.55, label: 'בינוני (3-5 אימונים בשבוע)' },
  { id: 1.725, label: 'גבוה (6-7 אימונים בשבוע)' },
  { id: 1.9, label: 'גבוה מאוד (עבודה פיזית + אימונים)' },
];

export const GOALS = [
  { id: -500, label: 'ירידה (~0.5 ק״ג בשבוע)' },
  { id: -250, label: 'ירידה מתונה (~0.25 ק״ג בשבוע)' },
  { id: 0, label: 'שמירה על המשקל' },
  { id: 300, label: 'עלייה במסה' },
];

export const MIN_TARGET = 1200;

const r1 = (x) => Math.round(x * 10) / 10;

// grams for an amount expressed either in grams (unit "g") or in a household measure code
export function gramsFor(food, amount, unit = 'g') {
  const qty = Number(amount) || 0;
  if (unit === 'g') return qty;
  const m = (food.m || []).find(([code]) => String(code) === String(unit));
  if (!m) throw new Error(`unknown unit ${unit} for ${food.id}`);
  return r1(qty * m[1]);
}

export function nutrientsFor(food, grams) {
  const k = (Number(grams) || 0) / 100;
  return {
    kcal: Math.round((food.kcal || 0) * k),
    p: r1((food.p || 0) * k),
    c: r1((food.c || 0) * k),
    f: r1((food.f || 0) * k),
  };
}

export function sumEntries(entries) {
  const t = { kcal: 0, p: 0, c: 0, f: 0 };
  for (const e of entries) {
    t.kcal += e.kcal || 0;
    t.p += e.p || 0;
    t.c += e.c || 0;
    t.f += e.f || 0;
  }
  return { kcal: Math.round(t.kcal), p: r1(t.p), c: r1(t.c), f: r1(t.f) };
}

export function totalsByMeal(entries) {
  const out = {};
  for (const meal of MEALS) out[meal.id] = sumEntries(entries.filter((e) => e.meal === meal.id));
  return out;
}

// Mifflin-St Jeor basal metabolic rate, kcal/day
export function bmr({ sex, weight, height, age }) {
  const base = 10 * weight + 6.25 * height - 5 * age;
  return Math.round(sex === 'female' ? base - 161 : base + 5);
}

export function dailyTarget(profile) {
  const tdee = bmr(profile) * Number(profile.activity || 1.2);
  return Math.max(MIN_TARGET, Math.round((tdee + Number(profile.goal || 0)) / 10) * 10);
}

// Default macro split for the progress bars: 25% protein, 45% carbs, 30% fat
export function macroTargets(kcal) {
  return {
    p: Math.round((kcal * 0.25) / 4),
    c: Math.round((kcal * 0.45) / 4),
    f: Math.round((kcal * 0.3) / 9),
  };
}

export function mealForHour(hour) {
  if (hour < 11) return 'breakfast';
  if (hour < 16) return 'lunch';
  if (hour < 21) return 'dinner';
  return 'snack';
}

export function isoDate(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return isoDate(new Date(y, m - 1, d + n));
}

// ---- backup format ----
export const BACKUP_VERSION = 1;
const TABLES = ['entries', 'myFoods', 'weights', 'settings', 'favorites'];

export function makeBackup(tables) {
  const out = { app: 'kalorit', version: BACKUP_VERSION, exportedAt: new Date().toISOString() };
  for (const t of TABLES) out[t] = tables[t] || [];
  return out;
}

export function parseBackup(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  if (!data || data.app !== 'kalorit') throw new Error('זה לא קובץ גיבוי של קלורית');
  if (data.version > BACKUP_VERSION) throw new Error('קובץ הגיבוי מגרסה חדשה יותר של האפליקציה');
  const out = {};
  for (const t of TABLES) {
    if (data[t] !== undefined && !Array.isArray(data[t])) throw new Error(`שדה ${t} בגיבוי פגום`);
    out[t] = data[t] || [];
  }
  return out;
}
