// Open Food Facts barcode lookup (https://world.openfoodfacts.org, free, no key).

const FIELDS = 'code,product_name,product_name_he,generic_name,brands,nutriments,serving_quantity,serving_size';

// a number, or null when the field is missing, empty or not a number ('' must not read as 0)
const num = (v) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
const r1 = (v) => Math.round(v * 10) / 10;

export function offToFood(product, barcode) {
  const n = product.nutriments || {};
  let kcal = num(n['energy-kcal_100g']);
  if (kcal === null && num(n.energy_100g) !== null) kcal = num(n.energy_100g) / 4.184;   // kJ only
  const name = String(product.product_name_he || product.product_name || product.generic_name || '').trim();
  if (!name || kcal === null) return null;
  const p = num(n.proteins_100g) ?? 0;
  const c = num(n.carbohydrates_100g) ?? 0;
  const f = num(n.fat_100g) ?? 0;
  // impossible values (typos in the open database): let the user type the label instead
  if (kcal < 0 || kcal > 900 || [p, c, f].some((v) => v < 0 || v > 100)) return null;
  const food = {
    id: 'b' + barcode,
    barcode,
    n: [name.trim(), product.brands ? product.brands.split(',')[0].trim() : ''].filter(Boolean).join(', '),
    kcal: Math.round(kcal),
    p: r1(p),
    c: r1(c),
    f: r1(f),
    m: [],
    src: 'off',
  };
  const serving = num(product.serving_quantity);
  if (serving > 0 && serving <= 2000) food.m.push(['serving', serving]);
  return food;
}

// Resolves to a food, or null when the product is unknown or has no nutrition data.
export async function lookupBarcode(barcode, { timeoutMs = 8000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${FIELDS}`,
      { signal: ctrl.signal },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`OFF ${res.status}`);
    const data = await res.json();
    if (data.status !== 1 || !data.product) return null;
    return offToFood(data.product, barcode);
  } finally {
    clearTimeout(timer);
  }
}
