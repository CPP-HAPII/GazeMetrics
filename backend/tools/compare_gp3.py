"""Compare a GazeMetrics (WebGazer) session with a Gazepoint GP3 recording.

Both must have been recorded on the same computer at the same time: the
GazeMetrics session in the browser, and the GP3 with gp3_logger.py. The two
are lined up by this computer's clock, and for each WebGazer sample the GP3
sample nearest in time is taken as the "true" gaze position.

Run from the backend folder (it reads the session from the database in
backend/.env):

    python tools/compare_gp3.py --session 12 --gp3 gp3_20261027_141500.csv
    python tools/compare_gp3.py --session 12 --gp3 lab_test_1.csv --screen 1920x1080 \
        --screen-width-cm 53 --distance-cm 65 --out session12_pairs.csv

--screen is the monitor's resolution in pixels (to report the error in
pixels); --screen-width-cm and --distance-cm (the participant's eyes to the
screen) add the error in degrees of visual angle, as in Psarra et al.

The browser must have been in full screen (F11) when the capture page was
opened, so that its window is the whole screen: WebGazer positions are
relative to the browser window, GP3 positions to the screen.
"""
import argparse
import asyncio
import math
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "utils"))
from sqlalchemy import text  # noqa: E402
from db.database import engine  # noqa: E402


async def _load_session(session_id):
    async with engine.connect() as conn:
        session = (await conn.execute(
            text("SELECT id, participant_name, browser_width, browser_height "
                 "FROM sessions WHERE id = :s"),
            {"s": session_id},
        )).mappings().first()
        samples = (await conn.execute(
            text("SELECT x, y, seconds_from_start::float8 AS timestamp, element_id FROM gaze_readable "
                 "WHERE session_id = :s ORDER BY seconds_from_start"),
            {"s": session_id},
        )).mappings().all()
        visits = (await conn.execute(
            text("SELECT page_order, page_id, started_at FROM pages "
                 "WHERE session_id = :s ORDER BY page_order"),
            {"s": session_id},
        )).mappings().all()
    await engine.dispose()
    return session, samples, visits


def load_webgazer(session_id):
    """WebGazer samples of a session, with clock times and screen fractions."""
    session, samples, visits = asyncio.run(_load_session(session_id))
    if not session:
        raise SystemExit(f"Session {session_id} not found.")
    if not samples:
        raise SystemExit(f"Session {session_id} has no gaze samples.")
    if not visits:
        raise SystemExit(
            f"Session {session_id} has no page visits, so its recording start time is unknown."
        )
    visits = pd.DataFrame(visits)
    visits["start"] = pd.to_datetime(visits["started_at"], utc=True).map(lambda t: t.timestamp())
    # Gaze timestamps count from "Start recording", which is also when the
    # first page visit began, on the same browser clock.
    recording_start = visits.loc[visits["page_order"].idxmin(), "start"]

    wg = pd.DataFrame(samples)
    wg["time"] = recording_start + wg["timestamp"].astype(float)
    wg["fx"] = wg["x"].astype(float) / session["browser_width"]
    wg["fy"] = wg["y"].astype(float) / session["browser_height"]
    return dict(session), wg, visits[["page_id", "start"]]


def load_gp3(path):
    """Valid GP3 samples (both eyes combined) with clock times."""
    gp3 = pd.read_csv(path)
    gp3 = gp3[gp3["BPOGV"] == 1]
    return pd.DataFrame({
        "time": gp3["wall_time"].astype(float),
        "gx": gp3["BPOGX"].astype(float),
        "gy": gp3["BPOGY"].astype(float),
    }).sort_values("time")


def match(wg, gp3, visits, tolerance):
    """Pair each WebGazer sample with the nearest GP3 sample within `tolerance`
    seconds, and tag it with the page that was on screen."""
    pairs = pd.merge_asof(
        wg.sort_values("time"), gp3, on="time", direction="nearest", tolerance=tolerance
    ).dropna(subset=["gx", "gy"])
    pairs = pd.merge_asof(
        pairs, visits.sort_values("start"), left_on="time", right_on="start", direction="backward"
    )
    return pairs


def describe(errors, unit):
    return (f"mean {errors.mean():.1f} {unit}, median {errors.median():.1f} {unit}, "
            f"90th percentile {errors.quantile(0.9):.1f} {unit}")


def main():
    parser = argparse.ArgumentParser(description="Compare a WebGazer session with a GP3 recording.")
    parser.add_argument("--session", type=int, required=True, help="GazeMetrics session id")
    parser.add_argument("--gp3", required=True, help="CSV written by gp3_logger.py")
    parser.add_argument("--screen", help="monitor resolution, e.g. 1920x1080")
    parser.add_argument("--screen-width-cm", type=float, help="visible screen width in cm")
    parser.add_argument("--distance-cm", type=float, help="eyes-to-screen distance in cm")
    parser.add_argument("--tolerance", type=float, default=0.05,
                        help="max time gap (s) between paired samples (default 0.05)")
    parser.add_argument("--out", help="write every pair to this CSV")
    args = parser.parse_args()

    session, wg, visits = load_webgazer(args.session)
    gp3 = load_gp3(args.gp3)
    if gp3.empty:
        raise SystemExit("The GP3 file has no valid samples.")
    pairs = match(wg, gp3, visits, args.tolerance)

    print(f"Session {session['id']} ({session['participant_name']}), "
          f"browser {session['browser_width']}x{session['browser_height']}")
    print(f"WebGazer samples: {len(wg)}  GP3 valid samples: {len(gp3)}  paired: {len(pairs)}")
    if pairs.empty:
        raise SystemExit(
            "No samples overlap in time. Were both recorded at the same time on this computer?"
        )

    # Distance between the two gaze positions, as a fraction of the screen
    # diagonal, and in pixels / degrees when the screen is described.
    dfx = pairs["fx"] - pairs["gx"]
    dfy = pairs["fy"] - pairs["gy"]
    if args.screen:
        width_px, height_px = (int(v) for v in args.screen.lower().split("x"))
    else:
        width_px, height_px = session["browser_width"], session["browser_height"]
    pairs["error_px"] = ((dfx * width_px) ** 2 + (dfy * height_px) ** 2) ** 0.5
    pairs["error_pct_diagonal"] = 100 * pairs["error_px"] / math.hypot(width_px, height_px)
    unit_note = "" if args.screen else " (in browser pixels; pass --screen for monitor pixels)"
    print(f"\nWebGazer vs GP3 distance{unit_note}:")
    print("  " + describe(pairs["error_px"], "px"))
    print("  " + describe(pairs["error_pct_diagonal"], "% of screen diagonal"))
    if args.screen_width_cm and args.distance_cm:
        cm_per_px = args.screen_width_cm / width_px
        pairs["error_deg"] = pairs["error_px"].map(
            lambda px: math.degrees(math.atan(px * cm_per_px / args.distance_cm))
        )
        print("  " + describe(pairs["error_deg"], "degrees"))
    for limit in (100, 200, 300):
        print(f"  within {limit} px: {100 * (pairs['error_px'] <= limit).mean():.0f}% of samples")
    print(f"  average offset: WebGazer is {100 * dfx.mean():+.1f}% of the width to the right "
          f"and {100 * dfy.mean():+.1f}% of the height below the GP3")

    per_page = (pairs.groupby("page_id", sort=False)["error_px"]
                .agg(samples="count", mean_px="mean", median_px="median").round(1))
    print("\nPer page:")
    print(per_page.to_string())

    if args.out:
        pairs.to_csv(args.out, index=False)
        print(f"\nAll pairs written to {args.out}")


if __name__ == "__main__":
    main()
