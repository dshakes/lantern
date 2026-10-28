"""Which region's revenue dropped the most, month over month? Prints one JSON line
and writes chart.png next to the CSV. Usage: analyze.py sales.csv"""
import json
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd

csv = sys.argv[1]
df = pd.read_csv(csv, parse_dates=["month"])
pivot = df.pivot_table(index="month", columns="region", values="revenue", aggfunc="sum").sort_index()
change = (pivot.iloc[-1] - pivot.iloc[-2]).sort_values()
pivot.plot(marker="o", title="Revenue by region")
plt.savefig(csv.rsplit("/", 1)[0] + "/chart.png")
print(json.dumps({"dropped_region": change.index[0], "delta": float(change.iloc[0]),
                  "deltas": {k: float(v) for k, v in change.items()}}))
