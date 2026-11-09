"""Expense log server: keeps expenses in data/expenses.csv and adds them up.

Peers runs this in a sandbox once the owner allows it (ADR 0007). It listens on $PORT,
writes only in $PEERS_DATA, and could read the vault through $PEERS_API.
"""
import csv
import json
import os
from collections import defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DATA = os.environ.get("PEERS_DATA", "data")
FILE = os.path.join(DATA, "expenses.csv")
FIELDS = ["date", "amount", "category", "note"]


def load():
    if not os.path.exists(FILE):
        return []
    with open(FILE, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def add(row):
    new = not os.path.exists(FILE)
    with open(FILE, "a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        if new:
            w.writeheader()
        w.writerow({k: row.get(k, "") for k in FIELDS})


def summary(rows):
    months, categories = defaultdict(float), defaultdict(float)
    for r in rows:
        try:
            amount = float(r["amount"])
        except (KeyError, ValueError):
            continue
        months[r["date"][:7]] += amount
        categories[r.get("category") or "other"] += amount
    return {"months": dict(sorted(months.items())), "categories": dict(sorted(categories.items(), key=lambda kv: -kv[1]))}


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        rows = load()
        if self.path.startswith("/expenses"):
            return self.reply(200, {"expenses": rows[-200:], "summary": summary(rows)})
        self.reply(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/expenses"):
            return self.reply(404, {"error": "not found"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            row = {
                "date": str(body["date"])[:10],
                "amount": f'{float(body["amount"]):.2f}',
                "category": str(body.get("category", "")).strip()[:40],
                "note": str(body.get("note", "")).strip()[:200],
            }
        except (KeyError, ValueError, TypeError):
            return self.reply(400, {"error": "date and amount are required"})
        add(row)
        self.reply(201, {"ok": True, "expense": row})

    def log_message(self, fmt, *args):
        print(fmt % args, flush=True)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    print(f"expense log on port {port}", flush=True)
    ThreadingHTTPServer((os.environ.get("HOST", "127.0.0.1"), port), Handler).serve_forever()
