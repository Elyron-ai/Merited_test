"""PH2-8: feature assembly + offline training (architecture §6 — Python
enters the codebase here and only here).

The structural claim this file must keep true (the task's Accept): features
read EXCLUSIVELY from the B19 ledger-derived read models — the four tables
below and nothing else. The projections are disposable and rebuilt from the
ledger, so `pnpm analytics:rebuild` followed by this script IS "trained on
ledger exhaust". A source-scan test enforces the table allowlist.

Model: next-day conversion propensity per (merchant, day) — LightGBM when
available (deterministic params), a tiny pure-Python logistic regression
otherwise, so the pipeline runs end to end on any machine. The artefact is
versioned by CONTENT HASH: same ledger, same version, byte for byte.
"""

import hashlib
import json
import math
import os
import sys

# The ONLY tables features may read (B19, PH1-19). The test scans this file.
READ_MODELS = (
    "core.mint_vs_claim_by_merchant_day",
    "core.budget_burn",
    "core.rejections_by_reason_day",
    "core.conversions_by_agent_day",
)

FEATURES = [
    "mints",
    "claims",
    "verified",
    "rejected",
    "claim_rate_bps",
    "burn_pence",
    "budget_rejections",
    "other_rejections",
    "trail3_claim_rate_bps",
]


def fetch_rows(database_url):
    import psycopg2  # deferred: the source scan cares about SQL, not imports

    query = """
        SELECT mc.merchant_id,
               mc.day::text,
               mc.mints::int,
               mc.claims::int,
               mc.verified::int,
               mc.rejected::int,
               COALESCE(bb.burn, 0)::bigint AS burn_pence,
               COALESCE(rr.budget_rejections, 0)::int AS budget_rejections,
               COALESCE(rr.other_rejections, 0)::int AS other_rejections
          FROM core.mint_vs_claim_by_merchant_day mc
          LEFT JOIN (
                SELECT merchant_id, day, SUM(bounty_burned_pence) AS burn
                  FROM core.budget_burn GROUP BY merchant_id, day
               ) bb ON bb.merchant_id = mc.merchant_id AND bb.day = mc.day
          LEFT JOIN (
                SELECT merchant_id, day,
                       SUM(count) FILTER (WHERE reason_code = 'BUDGET_EXHAUSTED') AS budget_rejections,
                       SUM(count) FILTER (WHERE reason_code <> 'BUDGET_EXHAUSTED') AS other_rejections
                  FROM core.rejections_by_reason_day GROUP BY merchant_id, day
               ) rr ON rr.merchant_id = mc.merchant_id AND rr.day = mc.day
         ORDER BY mc.merchant_id, mc.day
    """
    with psycopg2.connect(database_url) as conn, conn.cursor() as cur:
        cur.execute(query)
        return cur.fetchall()


def assemble(rows):
    """Per (merchant, day) features; label = any verified conversion NEXT day."""
    by_merchant = {}
    for merchant_id, day, mints, claims, verified, rejected, burn, brej, orej in rows:
        by_merchant.setdefault(merchant_id, []).append(
            dict(day=day, mints=mints, claims=claims, verified=verified,
                 rejected=rejected, burn=int(burn), brej=brej, orej=orej)
        )
    xs, ys = [], []
    for merchant_id in sorted(by_merchant):
        series = by_merchant[merchant_id]  # already day-ordered by the SQL
        for i in range(len(series) - 1):  # the last day has no "next day" label
            row = series[i]
            rate = (row["claims"] * 10000) // row["mints"] if row["mints"] else 0
            trail = series[max(0, i - 2): i + 1]
            trail_mints = sum(r["mints"] for r in trail)
            trail_claims = sum(r["claims"] for r in trail)
            trail_rate = (trail_claims * 10000) // trail_mints if trail_mints else 0
            xs.append([
                row["mints"], row["claims"], row["verified"], row["rejected"],
                rate, row["burn"], row["brej"], row["orej"], trail_rate,
            ])
            ys.append(1 if series[i + 1]["verified"] > 0 else 0)
    return xs, ys


def train_lightgbm(xs, ys):
    import lightgbm as lgb
    import numpy as np

    train_set = lgb.Dataset(np.array(xs, dtype=np.float64), label=np.array(ys), feature_name=FEATURES)
    booster = lgb.train(
        {
            "objective": "binary",
            "metric": "binary_logloss",
            "num_threads": 1,
            "seed": 7,
            "deterministic": True,
            "force_row_wise": True,
            "verbosity": -1,
            "min_data_in_leaf": 5,
        },
        train_set,
        num_boost_round=30,
    )
    return {"backend": "lightgbm", "model": booster.model_to_string()}


def train_logistic(xs, ys):
    """Stdlib fallback: fixed-epoch logistic regression on scaled features."""
    scale = [max(max(abs(x[j]) for x in xs), 1) for j in range(len(FEATURES))]
    w = [0.0] * len(FEATURES)
    b = 0.0
    lr = 0.1
    for _ in range(300):
        gw = [0.0] * len(FEATURES)
        gb = 0.0
        for x, y in zip(xs, ys):
            z = b + sum(w[j] * (x[j] / scale[j]) for j in range(len(FEATURES)))
            p = 1.0 / (1.0 + math.exp(-max(-30, min(30, z))))
            err = p - y
            for j in range(len(FEATURES)):
                gw[j] += err * (x[j] / scale[j])
            gb += err
        n = len(xs)
        for j in range(len(FEATURES)):
            w[j] -= lr * gw[j] / n
        b -= lr * gb / n
    return {"backend": "logistic", "model": {"weights": w, "bias": b, "scale": scale}}


def main():
    database_url = os.environ.get("MERITED_DATABASE_URL")
    if not database_url:
        print("MERITED_DATABASE_URL is required", file=sys.stderr)
        return 1
    model_dir = os.environ.get("MERITED_MODEL_DIR") or os.path.join(
        os.path.dirname(__file__), "..", "models"
    )

    rows = fetch_rows(database_url)
    xs, ys = assemble(rows)
    if len(xs) < 50:
        print(f"exhaust too thin to train on: {len(xs)} rows (LEAD-4: run the generator)", file=sys.stderr)
        return 2

    try:
        trained = train_lightgbm(xs, ys)
    except ImportError:
        trained = train_logistic(xs, ys)

    payload = {
        "trained_from": "b19-read-models",
        "read_models": list(READ_MODELS),
        "feature_names": FEATURES,
        "rows": len(xs),
        "positives": sum(ys),
        **trained,
    }
    version = hashlib.sha256(
        json.dumps(payload, sort_keys=True).encode("utf-8")
    ).hexdigest()[:12]
    artefact = {"version": version, **payload}

    os.makedirs(model_dir, exist_ok=True)
    for name in (f"model-{version}.json", "latest.json"):
        with open(os.path.join(model_dir, name), "w", encoding="utf-8") as f:
            json.dump(artefact, f, sort_keys=True, indent=1)
    print(version)
    return 0


if __name__ == "__main__":
    sys.exit(main())
