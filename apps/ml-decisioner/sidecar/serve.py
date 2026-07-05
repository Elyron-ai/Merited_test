"""PH2-7: the ML sidecar — `rank(eligible, ctx)` over HTTP (§5.5: ML lives
here and NOWHERE else). Serves POST /rank: scores each eligible offer by
its merchant's next-day conversion propensity (the PH2-8 model over the
latest B19 read-model row for that merchant) and returns an ORDERING —
offer ids + scores, ties broken stably by offer_id. The offers themselves
never round-trip through the model; core verifies the permutation and
falls back to rules on anything questionable.

Stdlib http.server only — the sidecar's dependencies are the training
pipeline's (psycopg2; lightgbm optional, matching the artefact backend).
"""

import json
import math
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FEATURES = [
    "mints", "claims", "verified", "rejected", "claim_rate_bps",
    "burn_pence", "budget_rejections", "other_rejections", "trail3_claim_rate_bps",
]

# The ONLY tables the sidecar may read (B19 read models — same allowlist
# and the same structural scan as training/train.py).
MERCHANT_FEATURES_SQL = """
    SELECT mc.merchant_id,
           mc.mints::int, mc.claims::int, mc.verified::int, mc.rejected::int,
           COALESCE(bb.burn, 0)::bigint AS burn_pence,
           COALESCE(rr.budget_rejections, 0)::int,
           COALESCE(rr.other_rejections, 0)::int
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
     WHERE mc.merchant_id = ANY(%s)
       AND mc.day = (SELECT max(day) FROM core.mint_vs_claim_by_merchant_day m2
                      WHERE m2.merchant_id = mc.merchant_id)
"""


def load_artefact(model_dir):
    with open(os.path.join(model_dir, "latest.json"), encoding="utf-8") as f:
        return json.load(f)


class Scorer:
    def __init__(self, artefact, database_url):
        self.artefact = artefact
        self.database_url = database_url
        self.booster = None
        if artefact["backend"] == "lightgbm":
            import lightgbm as lgb

            self.booster = lgb.Booster(model_str=artefact["model"])

    def merchant_features(self, merchant_ids):
        import psycopg2

        with psycopg2.connect(self.database_url) as conn, conn.cursor() as cur:
            cur.execute(MERCHANT_FEATURES_SQL, (list(merchant_ids),))
            out = {}
            for row in cur.fetchall():
                merchant_id, mints, claims, verified, rejected, burn, brej, orej = row
                rate = (claims * 10000) // mints if mints else 0
                out[merchant_id] = [
                    mints, claims, verified, rejected, rate, int(burn), brej, orej, rate,
                ]
            return out

    def score(self, features):
        if self.booster is not None:
            import numpy as np

            return float(self.booster.predict(np.array([features], dtype=np.float64))[0])
        model = self.artefact["model"]
        z = model["bias"] + sum(
            w * (x / s) for w, x, s in zip(model["weights"], features, model["scale"])
        )
        return 1.0 / (1.0 + math.exp(-max(-30, min(30, z))))


def make_handler(scorer):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # quiet
            pass

        def send_json(self, status, body):
            data = json.dumps(body).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/healthz":
                self.send_json(200, {"ok": True, "model": scorer.artefact["version"]})
            else:
                self.send_json(404, {"error": "not found"})

        def do_POST(self):
            if self.path != "/rank":
                self.send_json(404, {"error": "not found"})
                return
            try:
                length = int(self.headers.get("content-length", "0"))
                request = json.loads(self.rfile.read(length))
                eligible = request["eligible"]
                merchants = {e["offer"]["merchant_id"] for e in eligible}
                features = scorer.merchant_features(merchants)
                default = [0] * len(FEATURES)  # unseen merchant → cold score
                scored = [
                    {
                        "offer_id": e["offer"]["offer_id"],
                        "score": scorer.score(features.get(e["offer"]["merchant_id"], default)),
                    }
                    for e in eligible
                ]
                # highest propensity first; STABLE tie-break by offer_id
                scored.sort(key=lambda s: (-s["score"], s["offer_id"]))
                self.send_json(200, {"ranked": scored, "model": scorer.artefact["version"]})
            except Exception as error:  # noqa: BLE001 — the sidecar never half-answers
                self.send_json(500, {"error": str(error)})

    return Handler


def main():
    database_url = os.environ.get("MERITED_DATABASE_URL")
    if not database_url:
        print("MERITED_DATABASE_URL is required", file=sys.stderr)
        return 1
    model_dir = os.environ.get("MERITED_MODEL_DIR") or os.path.join(
        os.path.dirname(__file__), "..", "models"
    )
    port = int(os.environ.get("MERITED_SIDECAR_PORT", "3400"))
    scorer = Scorer(load_artefact(model_dir), database_url)
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(scorer))
    print(f"ml-decisioner sidecar on 127.0.0.1:{port} (model {scorer.artefact['version']})", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
