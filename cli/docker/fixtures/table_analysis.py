"""Deterministic table analysis for the model-free container smoke test."""
import os
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__))
CASE = os.path.normpath(os.path.join(HERE, "..", ".."))
FIG = os.path.join(CASE, "host", "figures")
os.makedirs(FIG, exist_ok=True)

frame = pd.read_csv(os.path.join(CASE, "measurements.csv"))
groups = {name: part["value"].to_numpy(dtype=float) for name, part in frame.groupby("group")}
a, b = groups["A"], groups["B"]
pooled = np.sqrt(((len(a) - 1) * a.var(ddof=1) + (len(b) - 1) * b.var(ddof=1)) /
                 (len(a) + len(b) - 2))

print("n_rows = %d" % len(frame))
print("group_A_n = %d" % len(a))
print("group_B_n = %d" % len(b))
print("group_A_mean = %.3f" % a.mean())
print("group_B_mean = %.3f" % b.mean())
print("mean_difference = %.3f" % (b.mean() - a.mean()))
print("cohens_d = %.3f" % ((b.mean() - a.mean()) / pooled))

fig, ax = plt.subplots(figsize=(4.8, 3.0))
ax.scatter(["A"] * len(a), a, label="A")
ax.scatter(["B"] * len(b), b, label="B")
ax.set_ylabel("recorded value")
fig.tight_layout()
out = os.path.join(FIG, "fig_values.png")
fig.savefig(out, dpi=140)
print("figure_written = %s" % out)
