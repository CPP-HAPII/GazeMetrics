"""Record gaze from a Gazepoint GP3 eye tracker to a CSV file.

Used to compare WebGazer (what GazeMetrics records) with a hardware eye
tracker on the same computer at the same time. Reads the Open Gaze API that
Gazepoint Control serves on 127.0.0.1:4242 while it is running, and stamps
every sample with this computer's clock, so it can later be lined up with
the WebGazer data of a GazeMetrics session (see compare_gp3.py).

Run from the backend folder, with Gazepoint Control open and calibrated:

    python tools/gp3_logger.py
    python tools/gp3_logger.py --out lab_test_1.csv

Stop it with Ctrl+C after the participant has submitted the test.

Coordinates in the CSV are fractions of the screen (0-1, from the top-left
corner), as the GP3 reports them. A *V column is 1 when that sample is valid.
"""
import argparse
import csv
import datetime
import re
import socket
import time

# Data the GP3 should send, enabled in this order; ENABLE_SEND_DATA last,
# since it starts the stream.
ENABLE = [
    "ENABLE_SEND_COUNTER",
    "ENABLE_SEND_TIME",
    "ENABLE_SEND_POG_BEST",   # best point of gaze: both eyes combined
    "ENABLE_SEND_POG_FIX",    # fixation point of gaze
    "ENABLE_SEND_POG_LEFT",
    "ENABLE_SEND_POG_RIGHT",
    "ENABLE_SEND_DATA",
]

# Columns copied from each <REC .../> record (missing ones are left empty).
GP3_FIELDS = [
    "CNT", "TIME",
    "BPOGX", "BPOGY", "BPOGV",
    "FPOGX", "FPOGY", "FPOGS", "FPOGD", "FPOGID", "FPOGV",
    "LPOGX", "LPOGY", "LPOGV",
    "RPOGX", "RPOGY", "RPOGV",
]

ATTR = re.compile(r'(\w+)="([^"]*)"')


def main():
    parser = argparse.ArgumentParser(description="Record Gazepoint GP3 gaze data to CSV.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4242)
    parser.add_argument("--out", default=None, help="output CSV (default: gp3_<date>_<time>.csv)")
    args = parser.parse_args()
    out = args.out or datetime.datetime.now().strftime("gp3_%Y%m%d_%H%M%S.csv")

    try:
        sock = socket.create_connection((args.host, args.port), timeout=5)
    except OSError as e:
        raise SystemExit(
            f"Could not connect to Gazepoint Control at {args.host}:{args.port} ({e}).\n"
            "Make sure Gazepoint Control is open and the tracker is connected."
        )
    sock.settimeout(1)
    for item in ENABLE:
        sock.sendall(f'<SET ID="{item}" STATE="1" />\r\n'.encode())

    rows = valid = 0
    last_report = time.time()
    buffer = ""
    with open(out, "w", newline="") as f:
        writer = csv.writer(f)
        # wall_time: seconds since 1970 (UTC) on this computer's clock.
        writer.writerow(["wall_time", "wall_iso"] + GP3_FIELDS)
        print(f"Recording to {out}. Press Ctrl+C to stop.")
        try:
            while True:
                try:
                    chunk = sock.recv(65536)
                except socket.timeout:
                    continue
                if not chunk:
                    print("Gazepoint Control closed the connection.")
                    break
                now = time.time()
                buffer += chunk.decode(errors="replace")
                *lines, buffer = buffer.split("\r\n")
                for line in lines:
                    if not line.startswith("<REC"):
                        continue   # acknowledgements of the SET commands
                    attrs = dict(ATTR.findall(line))
                    writer.writerow(
                        [f"{now:.4f}", datetime.datetime.fromtimestamp(now, datetime.timezone.utc).isoformat()]
                        + [attrs.get(k, "") for k in GP3_FIELDS]
                    )
                    rows += 1
                    valid += attrs.get("BPOGV") == "1"
                if now - last_report >= 5:
                    f.flush()
                    pct = 100 * valid / rows if rows else 0
                    print(f"  {rows} samples, {pct:.0f}% valid")
                    last_report = now
        except KeyboardInterrupt:
            pass
        finally:
            try:
                sock.sendall(b'<SET ID="ENABLE_SEND_DATA" STATE="0" />\r\n')
            except OSError:
                pass
            sock.close()
    pct = 100 * valid / rows if rows else 0
    print(f"Stopped. {rows} samples saved to {out} ({pct:.0f}% valid).")


if __name__ == "__main__":
    main()
