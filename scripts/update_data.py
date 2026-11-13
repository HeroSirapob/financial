#!/usr/bin/env python3
"""ดึงราคาและคำนวณสัญญาณซื้อสำหรับทุก symbol ใน data/portfolio.json และ data/watchlist.json

ผลลัพธ์เขียนลง data/market.json ซึ่งหน้าเว็บอ่านไปแสดงผล
รัน:  pip install -r requirements.txt && python scripts/update_data.py
"""
from __future__ import annotations

import json
import math
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = DATA / "market.json"

SERIES_DAYS = 520          # จำนวนแท่งรายวันที่ส่งให้หน้าเว็บ (~2 ปี)
WEIGHTS = {"drawdown": 0.35, "technical": 0.25, "trend": 0.20, "valuation": 0.20}
LADDER_QUANTILES = [(0.50, "ไม้ 1"), (0.75, "ไม้ 2"), (0.90, "ไม้ 3"), (0.97, "ไม้ 4")]
FX_SYMBOLS = {"USD": "THB=X"}  # 1 หน่วยสกุลนั้น = กี่บาท


def clamp(x: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, x))


def r(x, nd=4):
    """ปัดเลขและแปลง NaN เป็น None เพื่อให้ JSON สะอาด"""
    if x is None:
        return None
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    if math.isnan(x) or math.isinf(x):
        return None
    return round(x, nd)


def load_symbols() -> dict[str, dict]:
    """รวม symbol จากพอร์ตและ watchlist (พอร์ตมาก่อน)"""
    symbols: dict[str, dict] = {}
    portfolio = json.loads((DATA / "portfolio.json").read_text(encoding="utf-8"))
    for h in portfolio.get("holdings", []):
        if h.get("symbol") and h.get("manual_price") is None:
            symbols.setdefault(h["symbol"], h)
    watch = json.loads((DATA / "watchlist.json").read_text(encoding="utf-8"))
    for w in watch.get("candidates", []):
        if w.get("symbol"):
            symbols.setdefault(w["symbol"], w)
    return symbols


def fetch_history(symbol: str, tries: int = 3):
    last_err = None
    for i in range(tries):
        try:
            tk = yf.Ticker(symbol)
            df = tk.history(period="5y", interval="1d", auto_adjust=True)
            if df is not None and len(df) > 0:
                close = df["Close"].dropna()
                close.index = pd.to_datetime(close.index).tz_localize(None).normalize()
                close = close[~close.index.duplicated(keep="last")]
                meta = {}
                try:
                    meta = dict(tk.history_metadata or {})
                except Exception:
                    pass
                return close, meta, tk
            last_err = "empty"
        except Exception as e:  # noqa: BLE001
            last_err = e
        time.sleep(2 * (i + 1))
    print(f"  ! {symbol}: ดึงราคาไม่สำเร็จ ({last_err})", file=sys.stderr)
    return None, {}, None


def fetch_fundamentals(tk) -> dict | None:
    """พื้นฐานแบบ best-effort — Yahoo บล็อกเป็นช่วง ๆ ถ้าไม่ได้ก็ข้าม"""
    try:
        info = tk.info or {}
    except Exception:
        return None
    keys = {
        "trailingPE": "pe", "forwardPE": "forward_pe", "trailingPegRatio": "peg",
        "targetMeanPrice": "target_mean", "dividendYield": "dividend_yield",
        "revenueGrowth": "revenue_growth", "profitMargins": "profit_margin",
        "marketCap": "market_cap", "beta": "beta",
    }
    out = {v: r(info.get(k)) for k, v in keys.items()}
    if all(v is None for v in out.values()):
        return None
    return out


def rsi(close: pd.Series, n: int = 14) -> pd.Series:
    d = close.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    rs = up / dn.replace(0, np.nan)
    return (100 - 100 / (1 + rs)).fillna(100)


def analyze(close: pd.Series, fundamentals: dict | None) -> dict:
    n = len(close)
    price = float(close.iloc[-1])
    prev = float(close.iloc[-2]) if n > 1 else price
    win = min(252, n)

    # --- 1) ส่วนลดจากจุดสูงสุด 52 สัปดาห์ เทียบกับประวัติของตัวเอง ---
    roll_high = close.rolling(win, min_periods=min(60, n)).max()
    dd_series = (1 - close / roll_high).dropna()
    high52 = float(close.iloc[-win:].max())
    low52 = float(close.iloc[-win:].min())
    dd = 1 - price / high52
    dd_rank = float((dd_series <= dd).mean() * 100) if len(dd_series) else 0.0
    s_dd = 0.0 if dd < 0.005 else dd_rank

    # --- 2) เทคนิคอล: RSI, ระยะห่างจากเส้น 200 วัน, Bollinger %B ---
    rsi14 = float(rsi(close).iloc[-1])
    ma50 = float(close.rolling(50).mean().iloc[-1]) if n >= 50 else None
    ma200_s = close.rolling(200).mean()
    ma200 = float(ma200_s.iloc[-1]) if n >= 200 else None
    dist200 = dist200_z = None
    if ma200:
        dist_s = (close / ma200_s - 1).dropna()
        dist200 = float(dist_s.iloc[-1])
        sd = float(dist_s.std())
        dist200_z = (dist200 - float(dist_s.mean())) / sd if sd > 0 else 0.0
    mid = close.rolling(20).mean()
    sd20 = close.rolling(20).std()
    pctb = None
    if n >= 20 and float(sd20.iloc[-1]) > 0:
        lower = float(mid.iloc[-1] - 2 * sd20.iloc[-1])
        upper = float(mid.iloc[-1] + 2 * sd20.iloc[-1])
        pctb = (price - lower) / (upper - lower)

    parts = [(clamp((70 - rsi14) / 45 * 100), 0.4)]
    if dist200_z is not None:
        parts.append((clamp((0.5 - dist200_z) / 2.5 * 100), 0.4))
    if pctb is not None:
        parts.append((clamp((1 - pctb) * 100), 0.2))
    s_tech = sum(v * w for v, w in parts) / sum(w for _, w in parts)

    # --- 3) ราคาเทียบแนวโน้มระยะยาวของตัวเอง (log-linear trend) ---
    trend_z = s_trend = None
    if n >= 400:
        y = np.log(close.values)
        x = np.arange(n)
        slope, intercept = np.polyfit(x, y, 1)
        resid = y - (slope * x + intercept)
        sd = float(resid.std())
        if sd > 0:
            trend_z = float(resid[-1] / sd)
            s_trend = clamp((0.5 - trend_z) / 2.5 * 100)

    # --- 4) มูลค่าพื้นฐาน (ถ้าดึงได้) ---
    s_val = None
    if fundamentals:
        vals = []
        tm = fundamentals.get("target_mean")
        if tm and tm > 0:
            upside = tm / price - 1
            fundamentals["target_upside"] = r(upside)
            vals.append(clamp(20 + upside / 0.30 * 80))
        peg = fundamentals.get("peg")
        if peg and peg > 0:
            vals.append(clamp((3 - peg) / 2 * 80))
        if vals:
            s_val = sum(vals) / len(vals)

    comps = {"drawdown": s_dd, "technical": s_tech, "trend": s_trend, "valuation": s_val}
    used = {k: v for k, v in comps.items() if v is not None}
    wsum = sum(WEIGHTS[k] for k in used)
    total = sum(v * WEIGHTS[k] for k, v in used.items()) / wsum

    # --- ขั้นบันไดราคาซื้อ จากการกระจายตัวของ drawdown ในอดีตของตัวเอง ---
    ladder = []
    last_dd = 0.0
    for q, label in LADDER_QUANTILES:
        if not len(dd_series):
            break
        lvl = float(dd_series.quantile(q))
        if lvl < 0.03 or lvl - last_dd < 0.02:   # ข้ามขั้นที่ตื้นหรือชิดกันเกินไป
            continue
        ladder.append({"label": label, "dd": r(lvl), "price": r(high52 * (1 - lvl)),
                       "hit": bool(dd >= lvl)})
        last_dd = lvl
    for i, step in enumerate(ladder):
        step["label"] = f"ไม้ {i + 1}"

    rets = close.pct_change().dropna()
    vol = float(rets.iloc[-252:].std() * math.sqrt(252)) if len(rets) > 20 else None

    def ret(days):
        return float(price / close.iloc[-days - 1] - 1) if n > days else None

    flags = []
    r1m = ret(21)
    if r1m is not None and vol and r1m < -1.5 * vol / math.sqrt(12):
        flags.append("falling_knife")
    if ma200 and price < ma200:
        flags.append("below_ma200")
    if n < 400:
        flags.append("short_history")

    tail = close.iloc[-SERIES_DAYS:]
    ma200_tail = ma200_s.iloc[-SERIES_DAYS:]
    epoch = pd.Timestamp("1970-01-01")
    return {
        "price": r(price), "prev_close": r(prev), "change_pct": r(price / prev - 1),
        "as_of": close.index[-1].strftime("%Y-%m-%d"),
        "high52": r(high52), "low52": r(low52),
        "drawdown": r(dd), "drawdown_rank": r(dd_rank, 1),
        "rsi14": r(rsi14, 1), "ma50": r(ma50), "ma200": r(ma200),
        "dist200": r(dist200), "dist200_z": r(dist200_z, 2),
        "bb_pctb": r(pctb, 2), "trend_z": r(trend_z, 2), "vol": r(vol),
        "ret": {"1m": r(r1m), "3m": r(ret(63)), "6m": r(ret(126)), "1y": r(ret(252))},
        "score": r(total, 1),
        "components": {k: r(v, 1) for k, v in comps.items()},
        "ladder": ladder, "flags": flags, "fundamentals": fundamentals,
        "series": {
            "d": [int((d - epoch).days) for d in tail.index],
            "c": [r(v) for v in tail.values],
            "ma200": [r(v) for v in ma200_tail.values],
        },
    }


def main() -> int:
    symbols = load_symbols()
    previous = {}
    if OUT.exists():
        try:
            previous = json.loads(OUT.read_text(encoding="utf-8")).get("assets", {})
        except Exception:
            previous = {}

    assets, errors = {}, []
    for sym, cfg in symbols.items():
        print(f"- {sym}")
        close, meta, tk = fetch_history(sym)
        if close is None or len(close) < 30:
            errors.append(sym)
            if sym in previous:           # เก็บข้อมูลรอบก่อนไว้ ดีกว่าหายไปเลย
                assets[sym] = {**previous[sym], "stale": True}
            continue
        fundamentals = None
        if cfg.get("type") == "stock":
            fundamentals = fetch_fundamentals(tk) or (previous.get(sym) or {}).get("fundamentals")
        a = analyze(close, fundamentals)
        a["currency"] = (meta.get("currency") or cfg.get("currency") or "USD").upper()
        a["name"] = cfg.get("name") or meta.get("longName") or meta.get("shortName") or sym
        assets[sym] = a
        time.sleep(0.4)

    fx = {"THB": {"rate": 1.0}}
    for cur, sym in FX_SYMBOLS.items():
        close, _, _ = fetch_history(sym)
        if close is None:
            errors.append(sym)
            if previous and (prev_fx := json.loads(OUT.read_text(encoding="utf-8")).get("fx", {}).get(cur)):
                fx[cur] = prev_fx
            continue
        tail = close.iloc[-SERIES_DAYS:]
        epoch = pd.Timestamp("1970-01-01")
        fx[cur] = {"rate": r(close.iloc[-1]),
                   "series": {"d": [int((d - epoch).days) for d in tail.index],
                              "c": [r(v) for v in tail.values]}}

    out = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "weights": WEIGHTS, "fx": fx, "assets": assets, "errors": errors,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"เขียน {OUT.relative_to(ROOT)} แล้ว: {len(assets)} สินทรัพย์, ผิดพลาด {len(errors)}: {errors}")
    return 1 if not assets else 0


if __name__ == "__main__":
    sys.exit(main())
