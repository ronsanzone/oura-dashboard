from __future__ import annotations

import math
import random
from datetime import date, datetime, time, timedelta, timezone

from .db import upsert_records


def seed_demo(connection, days: int = 120, seed: int = 42) -> int:
    rng = random.Random(seed)
    today = date.today()
    buckets = {name: [] for name in [
        "daily_sleep", "daily_readiness", "daily_activity", "daily_stress", "sleep", "heart_rate"
    ]}
    for offset in range(days - 1, -1, -1):
        day = today - timedelta(days=offset)
        wave = math.sin(offset / 8) * 4
        sleep_hours = max(5.0, min(9.2, rng.gauss(7.35 + wave / 15, 0.55)))
        hrv = max(18, rng.gauss(48 + wave, 7))
        rhr = max(43, rng.gauss(56 - wave / 3, 3))
        sleep_score = round(max(45, min(98, 62 + sleep_hours * 3 + rng.gauss(0, 4))))
        readiness = round(max(40, min(98, 55 + hrv / 2 - rhr / 5 + rng.gauss(0, 4))))
        steps = max(1200, round(rng.gauss(8200, 2600)))
        bedtime = datetime.combine(day - timedelta(days=1), time(23, 15), timezone.utc)
        bedtime += timedelta(minutes=rng.randint(-55, 55))
        endtime = bedtime + timedelta(hours=sleep_hours + rng.uniform(0.2, 0.8))
        total = round(sleep_hours * 3600)
        deep = round(total * rng.uniform(0.14, 0.22))
        rem = round(total * rng.uniform(0.18, 0.27))
        awake = round(rng.uniform(900, 2600))
        light = max(0, total - deep - rem)
        temperature = rng.gauss(0, 0.16)
        buckets["daily_sleep"].append({"id": f"ds-{day}", "day": str(day), "score": sleep_score})
        buckets["daily_readiness"].append({
            "id": f"dr-{day}", "day": str(day), "score": readiness,
            "temperature_deviation": round(temperature, 2),
            "contributors": {"hrv_balance": round(min(100, hrv * 1.7)), "resting_heart_rate": round(110-rhr)},
        })
        buckets["daily_activity"].append({
            "id": f"da-{day}", "day": str(day), "score": round(max(40, min(99, 65 + steps / 500 + rng.gauss(0, 5)))),
            "steps": steps, "active_calories": round(steps * rng.uniform(0.035, 0.055)),
        })
        buckets["daily_stress"].append({
            "id": f"stress-{day}", "day": str(day), "stress_high": round(rng.uniform(1800, 9200)),
            "recovery_high": round(rng.uniform(1200, 7200)), "day_summary": rng.choice(["normal", "normal", "restored", "stressful"]),
        })
        buckets["sleep"].append({
            "id": f"sleep-{day}", "day": str(day), "bedtime_start": bedtime.isoformat(), "bedtime_end": endtime.isoformat(),
            "total_sleep_duration": total, "deep_sleep_duration": deep, "rem_sleep_duration": rem,
            "light_sleep_duration": light, "awake_time": awake, "average_hrv": round(hrv, 1),
            "lowest_heart_rate": round(rhr - rng.uniform(1, 5), 1), "average_heart_rate": round(rhr + rng.uniform(1, 4), 1),
            "average_breath": round(rng.uniform(13.2, 16.5), 1), "efficiency": round(total / (total + awake) * 100),
        })
        for minute in range(0, 24 * 60, 30):
            timestamp = datetime.combine(day, time(0), timezone.utc) + timedelta(minutes=minute)
            circadian = 10 * math.sin((minute - 600) / 1440 * math.tau)
            bpm = round(max(45, rng.gauss(rhr + 14 + circadian, 4)))
            buckets["heart_rate"].append({"timestamp": timestamp.isoformat(), "bpm": bpm, "source": "awake"})
    return sum(upsert_records(connection, key, values) for key, values in buckets.items())

