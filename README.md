# GazeMetrics

Webcam eye-tracking platform for a language-assessment research study, built on top of the WebGazer + FastAPI foundation from [CPP-HAPII/EyeTrackingAnalysis](https://github.com/CPP-HAPII/EyeTrackingAnalysis).

This fork adapts the original standalone demo into the assessment system used for the CaMLA English Placement Test (EPT) eye-tracking study, run by the CPP-HAPII lab.

**Stack:** FastAPI service serving the frontend, gaze data persisted in PostgreSQL (migrated from the original SQLite demo), ST-DBSCAN fixation pipeline.

```
capture (WebGazer, browser)  ─►  FastAPI  ─►  PostgreSQL
                                    │
                                    ├─ raw gaze  ─►  heatmap.js overlay
                                    └─ ST-DBSCAN pipeline  ─►  fixations
```

## Status

- ✅ Webcam capture, calibration, heatmap, and fixation pipeline — inherited from the original repo, verified working locally
- ✅ Migrated storage from SQLite to PostgreSQL, with per-session `user_id` and `html_element_id` tracking, and batched writes (~every 5 seconds)
- 🚧 **In progress:** participant-facing test interface (100 sequential multiple-choice questions, 20 with audio), replacing the current sample page

## Getting started (new contributors)

Each person runs their own local PostgreSQL instance — this project does not use a shared/hosted database yet.

**1. Clone the repo**
```bash
git clone https://github.com/CPP-HAPII/GazeMetrics.git
cd GazeMetrics
```

**2. Install PostgreSQL** (if you don't have it) — https://www.postgresql.org/download/

**3. Create your local database and role**, using `psql` or pgAdmin's Query Tool:
```sql
CREATE ROLE gazemetrics WITH LOGIN PASSWORD 'gazemetrics';
CREATE DATABASE gazemetrics OWNER gazemetrics;
```

**4. Set up the backend environment**
```bash
cd backend
python3.11 -m venv venv
# Windows PowerShell:
venv\Scripts\Activate.ps1
# Mac/Linux:
source venv/bin/activate

pip install --upgrade pip
pip install -r requirements.txt
```

> If `st_dbscan` fails to build, run
> `pip install "setuptools<82.0.0" wheel` first, then re-run the install.

**5. Create your `.env` file** (copy `.env.example`, same folder) and fill in your own local connection string:
```
DATABASE_URL=postgresql+asyncpg://gazemetrics:gazemetrics@localhost:5432/gazemetrics
```

**6. Run it**
```bash
uvicorn main:app --reload --port 8000
```
Tables are created automatically on first run — no manual schema setup needed.

Then open **http://localhost:8000/**
- `/capture.html` — record a session
- `/viewer.html` — view heatmaps and fixations

**7. Verify data is saving correctly** — open pgAdmin (or `psql`) and check:
```sql
SELECT id, user_id, page_name, created_at FROM gazepoint_sessions ORDER BY id DESC LIMIT 5;
SELECT id, session_id, user_id, x, y, html_element_id, created_at FROM gazepoint_data ORDER BY id DESC LIMIT 20;
```

## Project layout

Same structure as the original demo — see [CPP-HAPII/EyeTrackingAnalysis](https://github.com/CPP-HAPII/EyeTrackingAnalysis) for the base layout. Key files changed in this fork:

```
backend/utils/db/database.py    PostgreSQL connection via .env (was hardcoded SQLite)
backend/utils/db/models.py      + user_id, + html_element_id fields
backend/main.py                 session-scoped user_id generation, 5s batched writes
frontend/                       new assessment/test-taking interface (WIP)
```

## Requirements

- Python 3.11
- PostgreSQL
- A webcam
- A Chromium-based browser is recommended for WebGazer

## Notes & limitations

- **Accuracy** is webcam-based (WebGazer) — good for demos, not research-grade. Calibrate carefully and keep your head still.
- **Fixation processing** needs a reasonable amount of data — sessions with fewer than 40 gaze points are rejected.
- **Local-only databases:** each contributor runs their own Postgres instance right now. If we later need to share data across machines (e.g. for the real study), we'll move to a hosted option (Neon/Railway) — not needed yet.

## Credits

This project builds directly on:
- [CPP-HAPII/EyeTrackingAnalysis](https://github.com/CPP-HAPII/EyeTrackingAnalysis) by Yong Thu La Wong — WebGazer/FastAPI/SQLite foundation, calibration flow, heatmap visualization, and ST-DBSCAN fixation pipeline
- WebGazer — https://webgazer.cs.brown.edu/
- heatmap.js — https://www.patrick-wied.at/static/heatmapjs/
- Fixation scripts adapted from CSULB BEACH-Gaze-Converter — https://github.com/TheD2Lab/BEACH-Gaze-Converter
