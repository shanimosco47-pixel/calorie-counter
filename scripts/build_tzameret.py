"""Convert the Ministry of Health Tzameret CSVs into data/tzameret.json.

Usage: python3 scripts/build_tzameret.py <raw_csv_dir> [out_json]

Sources (data.gov.il/datasets/ministry-health/nutrition-database):
  moh_mitzrachim.csv                 foods, nutrients per 100 g
  moh_yehidot_mida.csv               unit code -> unit name
  moh_yehidot_mida_lemitzrachim.csv  food code, unit code -> grams per unit
  moh_matkonim.csv                   recipes: dish code, ingredient code, grams (used for the "egg" unit)
"""
import csv
import json
import os
import sys

SKIP_UNITS = {"700", "2000"}  # grams, kilogram: the app handles these itself

EGG_CODE = "1561"            # whole egg, raw, without shell
EGG_GRAMS = 49.5             # medium egg ("יחידה בינונית" of food 1561)


def egg_unit_label(name):
    """Dishes people count in eggs; None for dishes where eggs are a minor ingredient (bread, soup...)."""
    if name.startswith("שקשוקה"):
        return "ביצה (עם הרוטב)"
    if name.startswith("ביצה") or "חביתה" in name:
        return "ביצה"
    return None


def num(v):
    try:
        return round(float(v), 1)
    except (TypeError, ValueError):
        return 0


def read(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


PACKAGE_UNITS = {str(c) for c in range(900, 913)}   # whole packages: never borrowed


STATE_WORDS = ("מוכן", "אבקה", "יבש", "מבושל", "אפוי", "מטוגן", "קפוא", "פילה", "שלם", "קלוי", "לא אפוי", "משומר", "מיובש")
NO_BORROW = ("תמ\"ל", "תמ\"י", "תוסף", "תחליף", "מטרנה")   # infant formula, supplements: no guessing


def state(name):
    return {w for w in STATE_WORDS if w in name}


def words(name):
    return [w for w in name.replace(",", " ").replace("/", " ").split() if w]


def borrowed_measures(foods, measures, units):
    """Foods with no household measures borrow them from the most similar food in the same
    food subgroup (first 3 digits of the MoH code) that starts with the same word.
    Borrowed units are labelled with "≈" so the app can show they are estimates."""
    by_group = {}
    for f in foods:
        if measures.get(f["Code"]):
            by_group.setdefault(f["smlmitzrach"][:3], []).append(f)
    out = {}
    for f in foods:
        if measures.get(f["Code"]):
            continue
        name = " ".join(f["shmmitzrach"].split())
        mine = words(name)
        if not mine or "לא מבושל" in name or any(w in name for w in NO_BORROW):
            continue                                 # raw meat is weighed; formula is not guessed
        best, best_score = None, 0.0
        for g in by_group.get(f["smlmitzrach"][:3], []):
            their_name = " ".join(g["shmmitzrach"].split())
            theirs = words(their_name)
            if theirs[0] != mine[0] or state(their_name) != state(name):
                continue
            score = len(set(mine) & set(theirs)) / len(set(mine) | set(theirs))
            if score > best_score:
                best, best_score = g, score
        if best and best_score >= 0.35:
            borrowed = [["b" + m[0], m[1], "≈ " + (m[2] if len(m) > 2 else units[m[0]])]
                        for m in measures[best["Code"]] if m[0] not in PACKAGE_UNITS]
            if borrowed:
                out[f["Code"]] = borrowed
    return out


def egg_units(raw, foods):
    """Grams of dish per egg used, for egg dishes, anchored on energy so cooking water loss is
    accounted for: (recipe kcal / eggs in recipe) / (dish kcal per gram)."""
    by_code = {f["Code"]: f for f in foods}
    recipes = {}
    for row in read(os.path.join(raw, "moh_matkonim.csv")):
        recipes.setdefault(row["mmitzrach"], []).append(row)
    out = {}
    for code, rows in recipes.items():
        dish = by_code.get(code)
        label = dish and egg_unit_label(" ".join(dish["shmmitzrach"].split()))
        if not label:
            continue
        egg_g = sum(num(r["mishkal"]) for r in rows if r["mitzbsisi"] == EGG_CODE)
        dish_kcal = num(dish["food_energy"])
        if egg_g <= 0 or dish_kcal <= 0:
            continue
        kcal = 0
        for r in rows:
            ing = by_code.get(r["mitzbsisi"])
            if not ing:
                continue
            grams = num(r["mishkal"])
            if r["ahuz"]:                       # frying oil: only this percentage is absorbed
                grams = grams * num(r["ahuz"]) / 100
            kcal += grams * num(ing["food_energy"]) / 100
        eggs = egg_g / EGG_GRAMS
        grams_per_egg = round((kcal / eggs) / (dish_kcal / 100), 1)
        if grams_per_egg > 0:
            out[code] = (grams_per_egg, label)
    return out


def main(raw, out):
    foods = read(os.path.join(raw, "moh_mitzrachim.csv"))
    units = {u["smlmida"]: " ".join(u["shmmida"].split())
             for u in read(os.path.join(raw, "moh_yehidot_mida.csv"))}
    units["egg"] = "ביצה"

    measures = {}
    for row in read(os.path.join(raw, "moh_yehidot_mida_lemitzrachim.csv")):
        grams = num(row["mishkal"])
        if row["mida"] in SKIP_UNITS or row["mida"] not in units or grams <= 0:
            continue
        measures.setdefault(row["mmitzrach"], []).append([row["mida"], grams])
    for code, (grams, label) in egg_units(raw, foods).items():
        measures.setdefault(code, []).insert(0, ["egg", grams, label])
    borrowed = borrowed_measures(foods, measures, units)
    measures.update(borrowed)

    out_foods = []
    for f in foods:
        name = " ".join(f["shmmitzrach"].split())
        if not name or name.startswith("FFQ"):
            continue
        out_foods.append({
            "id": "t" + f["Code"],
            "n": name,
            "kcal": num(f["food_energy"]),
            "p": num(f["protein"]),
            "c": num(f["carbohydrates"]),
            "f": num(f["total_fat"]),
            "fib": num(f["total_dietary_fiber"]),
            "sug": num(f["total_sugars"]),
            "na": num(f["sodium"]),
            "m": sorted(measures.get(f["Code"], []), key=lambda m: -1 if m[0] == "egg" else int(m[0].lstrip("b"))),
        })

    used = {m[0] for f in out_foods for m in f["m"]}
    data = {
        "source": "משרד הבריאות, מאגר צמרת (data.gov.il)",
        "units": {k: v for k, v in units.items() if k in used},
        "foods": out_foods,
    }
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
    with_m = sum(1 for f in out_foods if f["m"])
    with_egg = sum(1 for f in out_foods if any(m[0] == "egg" for m in f["m"]))
    print(f"{len(out_foods)} foods, {with_m} with household measures ({len(borrowed)} borrowed), "
          f"{with_egg} with an egg unit -> {out}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "data/tzameret.json")
