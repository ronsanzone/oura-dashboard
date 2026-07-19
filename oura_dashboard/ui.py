from __future__ import annotations

from datetime import datetime, timezone

import plotly.graph_objects as go
import streamlit as st


COLORS = {
    "cyan": "#67e8f9",
    "blue": "#60a5fa",
    "indigo": "#818cf8",
    "violet": "#c084fc",
    "pink": "#f472b6",
    "green": "#34d399",
    "amber": "#fbbf24",
    "red": "#fb7185",
    "muted": "#718096",
    "grid": "#1c2633",
    "panel": "#0e141d",
}


CSS = """
<style>
  :root { color-scheme: dark; }
  .stApp { background:
    radial-gradient(circle at 15% -10%, rgba(37,99,235,.13), transparent 30rem),
    radial-gradient(circle at 90% 0%, rgba(8,145,178,.09), transparent 26rem), #080b10; }
  .block-container { max-width: 1780px; padding: .9rem 1.25rem 3rem; }
  [data-testid="stSidebar"] { background: #090d13; border-right: 1px solid #1a2430; }
  [data-testid="stSidebar"] .block-container { padding-top: 1rem; }
  h1, h2, h3 { letter-spacing: -.035em; }
  h1 { font-size: 1.8rem !important; margin: 0 !important; }
  h3 { font-size: 1rem !important; text-transform: uppercase; letter-spacing: .06em; color: #a9bbcc; }
  [data-testid="stMetric"] { background: linear-gradient(180deg,#111923,#0c121a); border: 1px solid #202c39;
    padding: .7rem .8rem; border-radius: 5px; box-shadow: inset 0 1px rgba(255,255,255,.025); }
  [data-testid="stMetricLabel"] { color: #7f93a8; font-size: .72rem; text-transform: uppercase; letter-spacing: .08em; }
  [data-testid="stMetricValue"] { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size: 1.45rem; }
  [data-testid="stMetricDelta"] { font-size: .68rem; }
  [data-testid="stVerticalBlockBorderWrapper"] { border-color: #1e2a37 !important; border-radius: 5px !important;
    background: linear-gradient(180deg,rgba(18,26,36,.82),rgba(10,15,22,.86)); }
  .stTabs [data-baseweb="tab-list"] { gap: .2rem; border-bottom: 1px solid #1d2935; }
  .stTabs [data-baseweb="tab"] { height: 2.45rem; padding: 0 .85rem; font-size: .76rem;
    text-transform: uppercase; letter-spacing: .06em; }
  .stTabs [aria-selected="true"] { color: #67e8f9 !important; background: #101923; }
  .stButton button { border-radius: 4px; font-size: .76rem; text-transform: uppercase; letter-spacing: .055em; }
  .stSelectbox label, .stMultiSelect label, .stDateInput label, .stSlider label { color: #8da1b5; font-size: .72rem; }
  .obs-kicker { color:#67e8f9; font: 600 .7rem ui-monospace,SFMono-Regular,monospace; letter-spacing:.16em; text-transform:uppercase; }
  .obs-sub { color:#71869a; font-size:.76rem; margin-top:.18rem; }
  .obs-panel-title { display:flex; align-items:center; justify-content:space-between; gap:.75rem; margin:0 0 .4rem; }
  .obs-panel-title b { color:#cbd9e6; font-size:.76rem; text-transform:uppercase; letter-spacing:.075em; }
  .obs-panel-title span { color:#66798c; font: .68rem ui-monospace,SFMono-Regular,monospace; }
  .obs-status { display:inline-flex; align-items:center; gap:.4rem; border:1px solid #234234; color:#70e1ae;
    background:#0b1a16; padding:.28rem .48rem; border-radius:999px; font:.66rem ui-monospace,SFMono-Regular,monospace; }
  .obs-dot { width:6px; height:6px; border-radius:50%; background:#34d399; box-shadow:0 0 8px #34d399; }
  .obs-rule { height:1px; background:#1b2632; margin:.65rem 0; }
  code { font-size: .72rem !important; }
  .stDataFrame { border: 1px solid #1d2935; }
  div[data-testid="stExpander"] { border-color:#1d2935; border-radius:4px; }
</style>
"""


def inject_css() -> None:
    st.markdown(CSS, unsafe_allow_html=True)


def panel_title(title: str, meta: str = "") -> None:
    st.markdown(
        f'<div class="obs-panel-title"><b>{title}</b><span>{meta}</span></div>',
        unsafe_allow_html=True,
    )


def status_badge(label: str = "API CONNECTED") -> str:
    return f'<span class="obs-status"><i class="obs-dot"></i>{label}</span>'


def style_figure(fig: go.Figure, height: int = 300, legend: bool = True) -> go.Figure:
    fig.update_layout(
        height=height,
        margin=dict(l=8, r=8, t=12, b=8),
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
        font=dict(color="#91a4b8", size=10),
        hoverlabel=dict(bgcolor="#101821", bordercolor="#293746", font_color="#dbe7f3"),
        hovermode="x unified",
        showlegend=legend,
        legend=dict(orientation="h", yanchor="bottom", y=1.01, xanchor="right", x=1, title=None),
        xaxis=dict(gridcolor=COLORS["grid"], zerolinecolor=COLORS["grid"], title=None),
        yaxis=dict(gridcolor=COLORS["grid"], zerolinecolor=COLORS["grid"], title=None),
    )
    return fig


def freshness(iso_timestamp: str | None) -> str:
    if not iso_timestamp:
        return "never"
    try:
        stamp = datetime.fromisoformat(iso_timestamp)
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=timezone.utc)
        seconds = max(0, int((datetime.now(timezone.utc) - stamp).total_seconds()))
        if seconds < 60:
            return f"{seconds}s ago"
        if seconds < 3600:
            return f"{seconds // 60}m ago"
        if seconds < 86400:
            return f"{seconds // 3600}h ago"
        return f"{seconds // 86400}d ago"
    except ValueError:
        return iso_timestamp

