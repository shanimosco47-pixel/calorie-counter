"""Convert the Ministry of Health Tzameret CSVs into data/tzameret.json.

Usage: python3 scripts/build_tzameret.py <raw_csv_dir> [out_json]

Sources (data.gov.il/datasets/ministry-health/nutrition-database):
  moh_mitzrachim.csv                 foods, nutrients per 100 g
  moh_yehidot_mida.csv               unit code -> unit name
  moh_yehidot_mida_lemitzrachim.csv  food code, unit code -> grams per unit
"""
import csv
import json
import os
import sys

SKIP_UNITS = {"700", "2000"}  # grams, kilogram: the app handles these itself


def num(v):
    try:
        return round(float(v), 1)
    except (TypeError, ValueError):
        return 0


def read(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def main(raw, out):
    foods = read(os.path.join(raw, "moh_mitzrachim.csv"))
    units = {u["smlmida"]: " ".join(u["shmmida"].split())
             for u in read(os.path.join(raw, "moh_yehidot_mida.csv"))}

    measures = {}
    for row in read(os.path.join(raw, "moh_yehidot_mida_lemitzrachim.csv")):
        grams = num(row["mishkal"])
        if row["mida"] in SKIP_UNITS or row["mida"] not in units or grams <= 0:
            continue
        measures.setdefault(row["mmitzrach"], []).append([row["mida"], grams])

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
            "m": sorted(measures.get(f["Code"], []), key=lambda m: int(m[0])),
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
    print(f"{len(out_foods)} foods, {with_m} with household measures -> {out}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "data/tzameret.json")
