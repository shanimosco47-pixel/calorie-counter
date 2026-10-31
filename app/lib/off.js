// Open Food Facts barcode lookup (https://world.openfoodfacts.org, free, no key).

const FIELDS = 'code,product_name,product_name_he,generic_name,brands,nutriments,serving_quantity,serving_size';

export function offToFood(product, barcode) {
  const n = product.nutriments || {};
  let kcal = n['energy-kcal_100g'];
  if (kcal == null && n.energy_100g != null) kcal = n.energy_100g / 4.184;   // kJ only
  const name = product.product_name_he || product.product_name || product.generic_name || '';
  if (!name || kcal == null) return null;
  const food = {
    id: 'b' + barcode,
    barcode,
    n: [name.trim(), product.brands ? product.brands.split(',')[0].trim() : ''].filter(Boolean).join(', '),
    kcal: Math.round(kcal),
    p: Number(n.proteins_100g) || 0,
    c: Number(n.carbohydrates_100g) || 0,
    f: Number(n.fat_100g) || 0,
    m: [],
    src: 'off',
  };
  const serving = Number(product.serving_quantity);
  if (serving > 0) food.m.push(['serving', serving]);
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
