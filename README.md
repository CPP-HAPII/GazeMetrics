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
- 🚧 **In progress:** migrating storage from SQLite to PostgreSQL, adding per-session user ID tracking, and batching gaze-point writes
- 🚧 **Planned:** participant-facing test interface (100 sequential multiple-choice questions, 20 with audio), replacing the current sample page

## What it does (current + planned)

1. **Capture** — consent → 9-point webcam calibration → gaze recorded while the participant takes the assessment
2. **Heatmap** — view raw gaze density overlaid on the page
3. **Fixations** — ST-DBSCAN pipeline clusters gaze into fixations with numbered look-order
4. **Assessment (planned)** — participants answer a sequence of test questions (dummy content for now; real CaMLA EPT content to follow) while gaze is tracked and stored per user session

## Requirements

- Python 3.11
- PostgreSQL
- A webcam
- A Chromium-based browser is recommended for WebGazer

## Setup

```bash
cd backend
python3.11 -m venv venv
source venv/bin/activate            # Windows: venv\Scripts\activate
pip install --upgrade pip
pip install -r requirements.txt
```

> If `st_dbscan` fails to build, run
> `pip install "setuptools<82.0.0" wheel` first, then re-run the install.

Set your PostgreSQL connection details in `.env` (see `.env.example`) before running the app. *(Add this once the migration lands.)*

## Run

```bash
cd backend
uvicorn main:app --reload --port 8000
```

Then open **http://localhost:8000/**

- `/capture.html` — record a session
- `/viewer.html` — view heatmaps and fixations

## Project layout

Same structure as the original demo — see [CPP-HAPII/EyeTrackingAnalysis](https://github.com/CPP-HAPII/EyeTrackingAnalysis) for the base layout. Key files being changed in this fork:

```
backend/utils/db/database.py    PostgreSQL connection (was SQLite)
backend/utils/db/models.py      + user_id, + html_element_id fields
frontend/                       new assessment/test-taking interface (WIP)
```

## Notes & limitations

- **Accuracy** is webcam-based (WebGazer) — good for demos, not research-grade. Calibrate carefully and keep your head still.
- **Fixation processing** needs a reasonable amount of data — sessions with fewer than 40 gaze points are rejected.

## Credits

This project builds directly on:
- [CPP-HAPII/EyeTrackingAnalysis](https://github.com/CPP-HAPII/EyeTrackingAnalysis) by Yong Thu La Wong — WebGazer/FastAPI/SQLite foundation, calibration flow, heatmap visualization, and ST-DBSCAN fixation pipeline
- WebGazer — https://webgazer.cs.brown.edu/
- heatmap.js — https://www.patrick-wied.at/static/heatmapjs/
- Fixation scripts adapted from CSULB BEACH-Gaze-Converter — https://github.com/TheD2Lab/BEACH-Gaze-Converter
