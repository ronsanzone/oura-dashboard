from __future__ import annotations

import json
import os
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
from plotly.subplots import make_subplots
import streamlit as st
from dotenv import load_dotenv

from oura_dashboard.db import (
    connect,
    database_status,
    initialize,
    load_records,
    record_counts,
)
from oura_dashboard.demo import seed_demo
from oura_dashboard.metrics import daily_frame, latest_delta
from oura_dashboard.ui import COLORS, freshness, inject_css, panel_title, status_badge, style_figure


ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")
DB_PATH = ROOT / os.getenv("OURA_DB_PATH", "data/oura.db")
LOCAL_TZ = "America/Los_Angeles"

st.set_page_config(page_title="Oura Observatory", page_icon="◉", layout="wide", initial_sidebar_state="expanded")
inject_css()


def database():
    connection = connect(DB_PATH)
    initialize(connection)
    return connection


def available(names: list[str], data: pd.DataFrame) -> list[str]:
    return [name for name in names if name in data and data[name].notna().any()]


def rows_of(records: list[dict], data_type: str) -> list[dict]:
    return [row for row in records if row.get("data_type") == data_type]


def no_data(message: str = "No telemetry in this window") -> None:
    st.caption(f"◌ {message}")


def contributor_heatmap(data: pd.DataFrame, prefix: str, title: str, height: int = 255) -> None:
    columns = [column for column in data.columns if column.startswith(prefix)]
    panel_title(title, f"{len(columns)} CONTRIBUTORS")
    if not columns:
        no_data()
        return
    values = data[columns].dropna(how="all")
    if values.empty:
        no_data()
        return
    labels = [column.split(".")[-1].replace("_", " ").title() for column in columns]
    fig = go.Figure(go.Heatmap(
        z=values[columns].values,
        x=labels,
        y=values.index.strftime("%b %d"),
        zmin=0,
        zmax=100,
        colorscale=[[0, "#331626"], [.45, "#7c3aed"], [.72, "#0891b2"], [1, "#5eead4"]],
        colorbar=dict(title="score", thickness=8),
        hovertemplate="%{y}<br>%{x}: %{z:.0f}<extra></extra>",
    ))
    style_figure(fig, height=height, legend=False)
    fig.update_layout(hovermode="closest")
    fig.update_xaxes(side="top", tickangle=-25)
    st.plotly_chart(fig, use_container_width=True, config={"displayModeBar": False})


def nested_series(records: list[dict], field: str, label: str) -> pd.DataFrame:
    rows = []
    for sleep in rows_of(records, "sleep"):
        block = sleep.get(field) or {}
        timestamp = block.get("timestamp")
        interval = block.get("interval")
        items = block.get("items") or []
        if not timestamp or not interval:
            continue
        start = pd.to_datetime(timestamp, utc=True)
        for index, value in enumerate(items):
            if value is not None:
                rows.append({"timestamp": start + pd.Timedelta(seconds=interval * index), label: value, "day": sleep.get("day")})
    return pd.DataFrame(rows)


def heart_rate_frame(records: list[dict]) -> pd.DataFrame:
    frame = pd.DataFrame(rows_of(records, "heart_rate"))
    if frame.empty:
        return frame
    frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True)
    frame["local_time"] = frame["timestamp"].dt.tz_convert(LOCAL_TZ)
    frame["day"] = frame["local_time"].dt.date
    frame["minute"] = frame["local_time"].dt.hour * 60 + frame["local_time"].dt.minute
    return frame.sort_values("timestamp")


def coverage_frame(records: list[dict]) -> pd.DataFrame:
    rows = []
    for data_type in sorted({row.get("data_type") for row in records}):
        subset = rows_of(records, data_type)
        normalized = pd.json_normalize(subset, sep=".")
        for column in normalized.columns:
            if column == "data_type":
                continue
            rows.append({
                "Dataset": data_type,
                "Field": column,
                "Coverage %": round(normalized[column].notna().mean() * 100, 1),
                "Non-null": int(normalized[column].notna().sum()),
            })
    return pd.DataFrame(rows)


connection = database()
counts = record_counts(connection)
if not counts:
    seed_demo(connection)
    counts = record_counts(connection)
status = database_status(connection)
connected = (ROOT / os.getenv("OURA_TOKEN_PATH", "data/token.json")).exists()

with st.sidebar:
    st.markdown('<div class="obs-kicker">Oura // OBS</div>', unsafe_allow_html=True)
    st.markdown("### Telemetry control")
    st.markdown(status_badge("API CONNECTED" if connected else "DEMO SOURCE"), unsafe_allow_html=True)
    st.markdown('<div class="obs-rule"></div>', unsafe_allow_html=True)

    window = st.radio("Window", ["7D", "30D", "90D", "Custom"], index=2, horizontal=True)
    presets = {"7D": 6, "30D": 29, "90D": 89}
    if window == "Custom":
        picked = st.date_input("Range", value=(date.today() - timedelta(days=89), date.today()), max_value=date.today())
        if isinstance(picked, tuple) and len(picked) == 2:
            start_date, end_date = picked
        else:
            start_date, end_date = date.today() - timedelta(days=89), date.today()
    else:
        start_date, end_date = date.today() - timedelta(days=presets[window]), date.today()
    smoothing = st.slider("Smoothing / days", 1, 21, 3)

    st.markdown('<div class="obs-rule"></div>', unsafe_allow_html=True)
    st.caption("INGEST STATUS")
    s1, s2 = st.columns(2)
    s1.metric("Records", f"{status['records']:,}")
    s2.metric("Datasets", len(counts))
    st.caption(f"Last sync · {freshness(status.get('last_sync'))}")
    st.caption(f"Coverage · {status.get('first_date') or '—'} → {status.get('last_date') or '—'}")

    if connected:
        if st.button("↻ Sync Oura now", width="stretch", type="primary"):
            from oura_dashboard.api import sync_all

            with st.spinner("Pulling cloud telemetry…"):
                sync_all()
            st.rerun()
    elif st.button("Regenerate demo telemetry", width="stretch"):
        seed_demo(connection)
        st.rerun()

    with st.expander("Dataset inventory"):
        for name, count in sorted(counts.items()):
            st.markdown(f"`{name:<22}` **{count:,}**")

records = load_records(connection, start_date=str(start_date), end_date=str(end_date))
daily = daily_frame(records)
hr = heart_rate_frame(records)

header_left, header_right = st.columns([4, 1])
with header_left:
    st.markdown('<div class="obs-kicker">Personal systems telemetry</div>', unsafe_allow_html=True)
    st.title("Body observability console")
    st.markdown(
        f'<div class="obs-sub">{start_date:%Y-%m-%d} → {end_date:%Y-%m-%d} &nbsp;·&nbsp; '
        f'{len(daily)} daily partitions &nbsp;·&nbsp; {len(hr):,} HR events &nbsp;·&nbsp; local-only storage</div>',
        unsafe_allow_html=True,
    )
with header_right:
    st.markdown("<br>", unsafe_allow_html=True)
    st.markdown(status_badge("PIPELINE HEALTHY"), unsafe_allow_html=True)

if daily.empty:
    st.warning("No daily telemetry exists for this window. Sync the ring or widen the time range.")
    st.stop()

metric_specs = [
    ("Readiness", "Readiness score", "", "normal"),
    ("Sleep score", "Sleep score", "", "normal"),
    ("Activity", "Activity score", "", "normal"),
    ("HRV", "Average HRV", " ms", "normal"),
    ("RHR min", "Lowest heart rate", " bpm", "inverse"),
    ("Sleep h", "Total sleep", " h", "normal"),
    ("SpO₂", "Average SpO₂", "%", "normal"),
    ("Temp Δ", "Temperature deviation", "°C", "inverse"),
]
metric_columns = st.columns(8)
for container, (label, column, suffix, direction) in zip(metric_columns, metric_specs):
    if column in daily:
        value, delta = latest_delta(daily[column])
        container.metric(label, value + suffix if value != "—" else value, delta, delta_color=direction)
    else:
        container.metric(label, "—", "no signal", delta_color="off")

command_tab, sleep_tab, cardio_tab, activity_tab, relations_tab, data_tab = st.tabs([
    "Command center", "Sleep telemetry", "Cardiovascular", "Activity + stress", "Relationships", "Data plane"
])

with command_tab:
    left, right = st.columns([1.8, 1])
    with left, st.container(border=True):
        panel_title("System scores", f"{smoothing}D ROLLING MEAN")
        score_columns = available(["Readiness score", "Sleep score", "Activity score"], daily)
        fig = go.Figure()
        for column, color in zip(score_columns, [COLORS["cyan"], COLORS["violet"], COLORS["green"]]):
            values = daily[column].rolling(smoothing, min_periods=1).mean()
            fig.add_trace(go.Scatter(x=daily.index, y=values, name=column.replace(" score", ""), mode="lines+markers",
                                     line=dict(width=2, color=color), marker=dict(size=5)))
        style_figure(fig, 300)
        fig.update_yaxes(range=[max(0, daily[score_columns].min().min() - 8), 100] if score_columns else [0, 100])
        st.plotly_chart(fig, use_container_width=True, config={"displayModeBar": False})

    with right, st.container(border=True):
        panel_title("Signal deviations", "LATEST VS WINDOW")
        anomaly_rows = []
        for column in available(["Average HRV", "Lowest heart rate", "Temperature deviation", "Total sleep", "Steps", "Average SpO₂"], daily):
            series = daily[column].dropna()
            if series.empty:
                continue
            mean, std, current = series.mean(), series.std(), series.iloc[-1]
            z = 0 if not std or np.isnan(std) else (current - mean) / std
            anomaly_rows.append({"signal": column, "current": round(current, 2), "window μ": round(mean, 2), "z-score": round(z, 2)})
        anomaly = pd.DataFrame(anomaly_rows)
        st.dataframe(anomaly, hide_index=True, width="stretch", height=263,
                     column_config={"z-score": st.column_config.ProgressColumn("z-score", min_value=-3, max_value=3, format="%.2f")})

    c1, c2 = st.columns([1.5, 1])
    with c1, st.container(border=True):
        panel_title("Physiological signals", "HRV / RHR / TEMPERATURE")
        fig = make_subplots(specs=[[{"secondary_y": True}]])
        if "Average HRV" in daily:
            fig.add_trace(go.Scatter(x=daily.index, y=daily["Average HRV"], name="HRV ms", line=dict(color=COLORS["cyan"], width=2)), secondary_y=False)
        if "Lowest heart rate" in daily:
            fig.add_trace(go.Scatter(x=daily.index, y=daily["Lowest heart rate"], name="Lowest HR", line=dict(color=COLORS["pink"], width=2)), secondary_y=False)
        if "Temperature deviation" in daily:
            fig.add_trace(go.Bar(x=daily.index, y=daily["Temperature deviation"], name="Temp Δ", marker_color=COLORS["amber"], opacity=.45), secondary_y=True)
        style_figure(fig, 285)
        fig.update_yaxes(title_text="ms / bpm", secondary_y=False)
        fig.update_yaxes(title_text="°C deviation", secondary_y=True, gridcolor="rgba(0,0,0,0)")
        st.plotly_chart(fig, use_container_width=True, config={"displayModeBar": False})

    with c2, st.container(border=True):
        panel_title("Daily state vector", "MOST RECENT PARTITION")
        state_columns = available([
            "Readiness score", "Sleep score", "Activity score", "Average HRV", "Lowest heart rate",
            "Total sleep", "Sleep efficiency", "Average SpO₂", "Steps", "Stress time", "Recovery time",
        ], daily)
        latest = daily[state_columns].ffill().iloc[-1].rename("value").reset_index().rename(columns={"index": "metric"})
        latest["value"] = latest["value"].map(lambda value: f"{value:,.2f}" if isinstance(value, (int, float, np.number)) else value)
        st.dataframe(latest, hide_index=True, width="stretch", height=248)

with sleep_tab:
    left, right = st.columns([1.55, 1])
    with left, st.container(border=True):
        panel_title("Sleep architecture", "HOURS BY STAGE")
        stages = available(["Deep sleep", "REM sleep", "Light sleep", "Awake"], daily)
        if stages:
            stage_long = daily[stages].reset_index().melt("day", var_name="stage", value_name="hours")
            fig = px.bar(stage_long, x="day", y="hours", color="stage", color_discrete_map={
                "Deep sleep": COLORS["indigo"], "REM sleep": COLORS["violet"],
                "Light sleep": COLORS["blue"], "Awake": COLORS["amber"],
            })
            style_figure(fig, 315)
            fig.update_layout(barmode="stack")
            st.plotly_chart(fig, use_container_width=True, config={"displayModeBar": False})
        else:
            no_data()
    with right, st.container(border=True):
        contributor_heatmap(daily, "daily_sleep.contributors.", "Sleep score contributors", 315)

    intranight_hr = nested_series(records, "heart_rate", "Heart rate")
    intranight_hrv = nested_series(records, "hrv", "HRV")
    left, right = st.columns([1.45, 1])
    with left, st.container(border=True):
        panel_title("Intranight physiology", f"{len(intranight_hr):,} HR · {len(intranight_hrv):,} HRV SAMPLES")
        fig = make_subplots(specs=[[{"secondary_y": True}]])
        if not intranight_hr.empty:
            fig.add_trace(go.Scattergl(x=intranight_hr["timestamp"], y=intranight_hr["Heart rate"], name="HR", line=dict(color=COLORS["pink"], width=1.5)), secondary_y=False)
        if not intranight_hrv.empty:
            fig.add_trace(go.Scattergl(x=intranight_hrv["timestamp"], y=intranight_hrv["HRV"], name="HRV", line=dict(color=COLORS["cyan"], width=1.25)), secondary_y=True)
        style_figure(fig, 300)
        fig.update_yaxes(title_text="bpm", secondary_y=False)
        fig.update_yaxes(title_text="ms", secondary_y=True, gridcolor="rgba(0,0,0,0)")
        st.plotly_chart(fig, use_container_width=True, config={"displayModeBar": False})

    with right, st.container(border=True):
        panel_title("Sleep quality signals", "EFFICIENCY / LATENCY / BREATH")
        quality = available(["Sleep efficiency", "Sleep latency", "Respiratory rate", "Restless periods"], daily)
        if quality:
            normalized = daily[quality].copy()
            normalized = (normalized - normalized.mean()) / normalized.std().replace(0, 1)
            fig = go.Figure()
            for column, color in zip(quality, [COLORS["green"], COLORS["amber"], COLORS["blue"], COLORS["red"]]):
                fig.add_trace(go.Scatter(x=normalized.index, y=normalized[column], name=column, line=dict(color=color, width=1.7)))
            style_figure(fig, 300)
            fig.update_yaxes(title="standard deviations")
            st.plotly_chart(fig, use_container_width=True, config={"displayModeBar": False})
        else:
            no_data()

    sleeps = rows_of(records, "sleep")
    if sleeps:
        latest_sleep = sorted(sleeps, key=lambda row: row.get("bedtime_start", ""))[-1]
        phases = latest_sleep.get("sleep_phase_30_sec") or ""
        if phases:
            with st.container(border=True):
                panel_title("Latest sleep-stage trace", f"{latest_sleep.get('day')} · 30S RESOLUTION")
                mapping = {"1": (1, "Deep"), "2": (2, "Light"), "3": (3, "REM"), "4": (4, "Awake")}
                start = pd.to_datetime(latest_sleep["bedtime_start"])
                phase_frame = pd.DataFrame({
                    "timestamp": [start + pd.Timedelta(seconds=30 * i) for i in range(len(phases))],
                    "value": [mapping.get(code, (np.nan, "Unknown"))[0] for code in phases],
                })
                fig = go.Figure(go.Scatter(x=phase_frame["timestamp"], y=phase_frame["value"], mode="lines",
                                           line=dict(shape="hv", color=COLORS["violet"], width=1.4), fill="tozeroy", fillcolor="rgba(129,140,248,.14)"))
                style_figure(fig, 230, legend=False)
                fig.update_yaxes(tickvals=[1, 2, 3, 4], ticktext=["Deep", "Light", "REM", "Awake"], range=[.7, 4.3])
                st.plotly_chart(fig, use_container_width=True, config={"displayModeBar": False})

with cardio_tab:
    left, right = st.columns([1.65, 1])
    with left, st.container(border=True):
        panel_title("Heart-rate event stream", f"{len(hr):,} EVENTS")
        if not hr.empty:
            fig = go.Figure()
            for source, color in zip(sorted(hr["source"].dropna().unique()), [COLORS["pink"], COLORS["amber"], COLORS["cyan"], COLORS["green"]]):
                subset = hr[hr["source"] == source]
                fig.add_trace(go.Scattergl(x=subset["local_time"], y=subset["bpm"], name=str(source), mode="markers",
                                           marker=dict(size=4, color=color, opacity=.7)))
            style_figure(fig, 330)
            fig.update_yaxes(title="bpm")
            st.plotly_chart(fig, use_container_width=True, config={"displayModeBar": False})
        else:
            no_data()
    with right, st.container(border=True):
        panel_title("Heart-rate distribution", "EVENT DENSITY")
        if not hr.empty:
            fig = px.histogram(hr, x="bpm", color="source", nbins=32, barmode="overlay",
                               color_discrete_sequence=[COLORS["pink"], COLORS["amber"], COLORS["cyan"]])
            style_figure(fig, 330)
            st.plotly_chart(fig, use_container_width=True, config={"displayModeBar": False})
        else:
            no_data()

    left, right = st.columns([1.65, 1])
    with left, st.container(border=True):
        panel_title("Circadian HR heatmap", "DAY × 30-MINUTE BUCKET")
        if not hr.empty:
            telemetry = hr.copy()
            telemetry["bucket"] = (telemetry["minute"] // 30) * 30
            pivot = telemetry.pivot_table(index="day", columns="bucket", values="bpm", aggfunc="mean")
            pivot = pivot.reindex(columns=range(0, 1440, 30))
            labels = [f"{minute // 60:02d}:{minute % 60:02d}" for minute in pivot.columns]
            fig = go.Figure(go.Heatmap(z=pivot.values, x=labels, y=[str(day) for day in pivot.index],
                                       colorscale="Turbo", colorbar=dict(title="bpm", thickness=8), connectgaps=False))
            style_figure(fig, 290, legend=False)
            fig.update_layout(hovermode="closest")
            fig.update_xaxes(dtick=4)
            st.plotly_chart(fig, use_container_width=True, config={"displayModeBar": False})
        else:
            no_data()
    with right, st.container(border=True):
        panel_title("Vascular telemetry", "CVA / PWV")
        vascular = available(["Vascular age", "Pulse wave velocity"], daily)
        if vascular:
            fig = make_subplots(specs=[[{"secondary_y": True}]])
            if "Vascular age" in vascular:
                fig.add_trace(go.Bar(x=daily.index, y=daily["Vascular age"], name="Vascular age", marker_color=COLORS["violet"]), secondary_y=False)
            if "Pulse wave velocity" in vascular:
                fig.add_trace(go.Scatter(x=daily.index, y=daily["Pulse wave velocity"], name="PWV", line=dict(color=COLORS["cyan"], width=2)), secondary_y=True)
            style_figure(fig, 290)
            st.plotly_chart(fig, use_container_width=True, config={"displayModeBar": False})
        else:
            no_data("Vascular metrics have not populated yet")

with activity_tab:
    left, right = st.columns([1.55, 1])
    with left, st.container(border=True):
        panel_title("Movement + energy", "STEPS / CALORIES")
        fig = make_subplots(specs=[[{"secondary_y": True}]])
        if "Steps" in daily:
            fig.add_trace(go.Bar(x=daily.index, y=daily["Steps"], name="Steps", marker_color=COLORS["blue"]), secondary_y=False)
        if "Active calories" in daily:
            fig.add_trace(go.Scatter(x=daily.index, y=daily["Active calories"], name="Active kcal", line=dict(color=COLORS["amber"], width=2)), secondary_y=True)
        style_figure(fig, 310)
        fig.update_yaxes(title_text="steps", secondary_y=False)
        fig.update_yaxes(title_text="kcal", secondary_y=True, gridcolor="rgba(0,0,0,0)")
        st.plotly_chart(fig, use_container_width=True, config={"displayModeBar": False})
    with right, st.container(border=True):
        panel_title("Movement intensity budget", "HOURS / DAY")
        intensities = available(["Sedentary time", "Low activity", "Medium activity", "High activity", "Resting time"], daily)
        if intensities:
            long = daily[intensities].reset_index().melt("day", var_name="state", value_name="hours")
            fig = px.bar(long, x="day", y="hours", color="state", color_discrete_sequence=[
                "#334155", COLORS["blue"], COLORS["cyan"], COLORS["green"], COLORS["violet"]
            ])
            style_figure(fig, 310)
            st.plotly_chart(fig, use_container_width=True, config={"displayModeBar": False})
        else:
            no_data()

    left, right = st.columns([1.4, 1])
    with left, st.container(border=True):
        contributor_heatmap(daily, "daily_activity.contributors.", "Activity score contributors", 290)
    with right, st.container(border=True):
        panel_title("Stress / recovery allocation", "HOURS")
        stress_columns = available(["Stress time", "Recovery time"], daily)
        if stress_columns:
            long = daily[stress_columns].reset_index().melt("day", var_name="state", value_name="hours")
            fig = px.bar(long, x="day", y="hours", color="state",
                         color_discrete_map={"Stress time": COLORS["red"], "Recovery time": COLORS["green"]}, barmode="group")
            style_figure(fig, 290)
            st.plotly_chart(fig, use_container_width=True, config={"displayModeBar": False})
        else:
            no_data()

    with st.container(border=True):
        workouts = pd.json_normalize(rows_of(records, "workout"), sep=".")
        panel_title("Workout event log", f"{len(workouts)} EVENTS")
        if not workouts.empty:
            display = workouts[[column for column in ["day", "activity", "label", "intensity", "calories", "distance", "start_datetime", "end_datetime", "source"] if column in workouts]].copy()
            if "distance" in display:
                display["distance_km"] = display.pop("distance") / 1000
            st.dataframe(display.sort_values("start_datetime", ascending=False) if "start_datetime" in display else display,
                         hide_index=True, width="stretch", height=260)
        else:
            no_data("No workouts in this window")

with relations_tab:
    numeric_candidates = available([
        "Readiness score", "Sleep score", "Activity score", "Average HRV", "Lowest heart rate",
        "Average heart rate", "Total sleep", "Deep sleep", "REM sleep", "Sleep efficiency",
        "Sleep latency", "Respiratory rate", "Temperature deviation", "Steps", "Active calories",
        "Stress time", "Recovery time", "Average SpO₂", "Breathing disturbance index",
    ], daily)
    left, right = st.columns([1.3, 1])
    with left, st.container(border=True):
        panel_title("Correlation matrix", f"N={len(daily)} DAYS · PEARSON")
        corr = daily[numeric_candidates].corr(min_periods=3) if len(numeric_candidates) > 1 else pd.DataFrame()
        if not corr.empty:
            fig = go.Figure(go.Heatmap(z=corr.values, x=corr.columns, y=corr.index, zmin=-1, zmax=1,
                                       colorscale=[[0, "#fb7185"], [.5, "#111827"], [1, "#67e8f9"]],
                                       colorbar=dict(title="r", thickness=8), hovertemplate="%{y} ↔ %{x}<br>r=%{z:.2f}<extra></extra>"))
            style_figure(fig, 560, legend=False)
            fig.update_layout(hovermode="closest")
            fig.update_xaxes(tickangle=-45)
            st.plotly_chart(fig, use_container_width=True, config={"displayModeBar": False})
        else:
            no_data("At least three overlapping days are required")
    with right, st.container(border=True):
        panel_title("Relationship explorer", "INTERACTIVE PAIR")
        x_metric = st.selectbox("X signal", numeric_candidates, index=min(6, len(numeric_candidates) - 1))
        y_metric = st.selectbox("Y signal", numeric_candidates, index=0)
        pair = daily[[x_metric, y_metric]].dropna().reset_index()
        if not pair.empty:
            pair["recency"] = np.arange(len(pair))
            fig = px.scatter(pair, x=x_metric, y=y_metric, color="recency", hover_data=["day"],
                             color_continuous_scale=[[0, "#334155"], [1, COLORS["cyan"]]])
            fig.update_traces(marker=dict(size=11, line=dict(width=1, color="#dbe7f3")))
            style_figure(fig, 365, legend=False)
            fig.update_layout(coloraxis_showscale=False, hovermode="closest")
            st.plotly_chart(fig, use_container_width=True, config={"displayModeBar": False})
            if len(pair) >= 3:
                st.metric("Pearson r", f"{pair[x_metric].corr(pair[y_metric]):+.3f}", f"{len(pair)} overlapping days", delta_color="off")
        st.caption("Correlations are descriptive and unstable with short histories; they do not imply causation.")

    with st.container(border=True):
        panel_title("Normalized signal overlay", "Z-SCORE COMPARISON")
        defaults = numeric_candidates[:min(4, len(numeric_candidates))]
        overlay = st.multiselect("Signals", numeric_candidates, default=defaults)
        if overlay:
            standardized = (daily[overlay] - daily[overlay].mean()) / daily[overlay].std().replace(0, 1)
            long = standardized.reset_index().melt("day", var_name="signal", value_name="z-score")
            fig = px.line(long, x="day", y="z-score", color="signal", color_discrete_sequence=[
                COLORS["cyan"], COLORS["violet"], COLORS["green"], COLORS["amber"], COLORS["pink"]
            ])
            style_figure(fig, 290)
            st.plotly_chart(fig, use_container_width=True, config={"displayModeBar": False})

with data_tab:
    left, right = st.columns([1, 1.6])
    with left, st.container(border=True):
        panel_title("Dataset cardinality", f"{sum(counts.values()):,} RECORDS")
        count_frame = pd.DataFrame([{"dataset": key, "records": value} for key, value in counts.items()]).sort_values("records")
        fig = px.bar(count_frame, x="records", y="dataset", orientation="h", color="records", color_continuous_scale="Teal")
        style_figure(fig, 350, legend=False)
        fig.update_layout(coloraxis_showscale=False)
        st.plotly_chart(fig, use_container_width=True, config={"displayModeBar": False})
    with right, st.container(border=True):
        panel_title("Schema coverage", "NON-NULL FIELD DENSITY")
        coverage = coverage_frame(records)
        if not coverage.empty:
            st.dataframe(coverage.sort_values(["Dataset", "Coverage %"], ascending=[True, False]), hide_index=True,
                         width="stretch", height=350,
                         column_config={"Coverage %": st.column_config.ProgressColumn("Coverage %", min_value=0, max_value=100, format="%.1f%%")})

    with st.container(border=True):
        panel_title("Raw event inspector", "LOSSLESS LOCAL PAYLOADS")
        datasets = sorted(counts)
        c1, c2, c3 = st.columns([1, 1, 1])
        selected_type = c1.selectbox("Dataset", datasets)
        limit = c2.selectbox("Row limit", [25, 100, 500, "All"], index=1)
        search = c3.text_input("Column filter", placeholder="hrv, score, timestamp…")
        selected_records = rows_of(records, selected_type)
        raw = pd.json_normalize(selected_records, sep=".") if selected_records else pd.DataFrame()
        if search:
            raw = raw[[column for column in raw.columns if search.lower() in column.lower()]]
        shown = raw if limit == "All" else raw.head(int(limit))
        st.dataframe(shown, width="stretch", hide_index=True, height=420)
        download_left, download_right = st.columns([1, 4])
        download_left.download_button("Download CSV", raw.to_csv(index=False).encode(),
                                      file_name=f"oura-{selected_type}-{start_date}-{end_date}.csv", mime="text/csv")
        download_right.caption(f"{len(raw):,} rows · {len(raw.columns):,} flattened fields · source JSON retained in SQLite")
        with st.expander("Raw JSON sample"):
            st.code(json.dumps(selected_records[:3], indent=2, default=str), language="json")

st.caption("Oura Observatory · local SQLite · API data is processed wellness telemetry, not raw PPG or accelerometer samples · not medical advice")
