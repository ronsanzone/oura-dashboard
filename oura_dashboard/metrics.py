from __future__ import annotations

from typing import Any

import pandas as pd


def frame(records: list[dict[str, Any]]) -> pd.DataFrame:
    if not records:
        return pd.DataFrame()
    return pd.json_normalize(records, sep=".")


def daily_frame(records: list[dict[str, Any]]) -> pd.DataFrame:
    frames = {}
    for kind in [
        "daily_sleep", "daily_readiness", "daily_activity", "daily_stress",
        "daily_spo2", "cardiovascular_age", "sleep",
    ]:
        subset = [item for item in records if item.get("data_type") == kind]
        if not subset:
            continue
        current = frame(subset)
        if "day" not in current:
            continue
        current["day"] = pd.to_datetime(current["day"])
        current = current.drop_duplicates("day", keep="last").set_index("day")
        current = current.drop(columns=[c for c in ["data_type", "id"] if c in current], errors="ignore")
        current.columns = [f"{kind}.{column}" for column in current.columns]
        frames[kind] = current
    if not frames:
        return pd.DataFrame()
    merged = pd.concat(frames.values(), axis=1).sort_index()
    seconds = {
        "sleep.total_sleep_duration": "Total sleep",
        "sleep.deep_sleep_duration": "Deep sleep",
        "sleep.rem_sleep_duration": "REM sleep",
        "sleep.light_sleep_duration": "Light sleep",
        "sleep.awake_time": "Awake",
        "sleep.time_in_bed": "Time in bed",
        "daily_activity.sedentary_time": "Sedentary time",
        "daily_activity.low_activity_time": "Low activity",
        "daily_activity.medium_activity_time": "Medium activity",
        "daily_activity.high_activity_time": "High activity",
        "daily_activity.resting_time": "Resting time",
        "daily_activity.non_wear_time": "Non-wear time",
        "daily_stress.stress_high": "Stress time",
        "daily_stress.recovery_high": "Recovery time",
    }
    for source, target in seconds.items():
        if source in merged:
            merged[target] = merged[source] / 3600
    names = {
        "daily_sleep.score": "Sleep score", "daily_readiness.score": "Readiness score",
        "daily_activity.score": "Activity score", "daily_activity.steps": "Steps",
        "daily_activity.active_calories": "Active calories", "sleep.average_hrv": "Average HRV",
        "sleep.lowest_heart_rate": "Lowest heart rate", "sleep.average_heart_rate": "Average heart rate",
        "sleep.average_breath": "Respiratory rate", "sleep.efficiency": "Sleep efficiency",
        "daily_readiness.temperature_deviation": "Temperature deviation",
        "daily_readiness.temperature_trend_deviation": "Temperature trend",
        "daily_activity.total_calories": "Total calories",
        "daily_activity.target_calories": "Calorie target",
        "daily_activity.average_met_minutes": "Average MET minutes",
        "daily_activity.inactivity_alerts": "Inactivity alerts",
        "daily_stress.day_summary": "Stress summary",
        "daily_spo2.spo2_percentage.average": "Average SpO₂",
        "daily_spo2.breathing_disturbance_index": "Breathing disturbance index",
        "cardiovascular_age.vascular_age": "Vascular age",
        "cardiovascular_age.pulse_wave_velocity": "Pulse wave velocity",
        "sleep.restless_periods": "Restless periods",
        "sleep.latency": "Sleep latency seconds",
        "sleep.readiness.score": "Sleep-period readiness",
    }
    merged = merged.rename(columns=names)
    if "Sleep latency seconds" in merged:
        merged["Sleep latency"] = merged["Sleep latency seconds"] / 60
    return merged


def latest_delta(series: pd.Series) -> tuple[str, str | None]:
    clean = series.dropna()
    if clean.empty:
        return "—", None
    latest = clean.iloc[-1]
    baseline = clean.tail(29).iloc[:-1].mean() if len(clean) > 1 else latest
    return f"{latest:.1f}", f"{latest - baseline:+.1f} vs baseline"
