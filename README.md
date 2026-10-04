# GazeMetrics

Webcam eye-tracking platform for a language-assessment research study, built on top of the WebGazer + FastAPI foundation from [CPP-HAPII/EyeTrackingAnalysis](https://github.com/CPP-HAPII/EyeTrackingAnalysis).

This fork adapts the original standalone demo into the assessment system used for the CaMLA English Placement Test (EPT) eye-tracking study, run by the CPP-HAPII lab.

## Live site

**https://gazemetrics-frontend.vercel.app/**

- `/capture.html` — take the test with eye tracking
- `/viewer.html` — view heatmaps and fixations for recorded sessions

Share this link, not the Render address below and not a link that has extra characters after `gazemetrics-frontend` (those point at one old deployment and ask for a Vercel login).

## How it is hosted

```
browser (WebGazer)  ─►  Vercel: static frontend
        │
        └─ /api/*   ─►  Render: FastAPI backend  ─►  Supabase: PostgreSQL
                              │
                              └─ ST-DBSCAN pipeline  ─►  fixations
```

| Part | Service | Address | What it holds |
|---|---|---|---|
| Frontend | Vercel (project `gazemetrics-frontend`, root directory `frontend/`) | https://gazemetrics-frontend.vercel.app | HTML, CSS and JavaScript only |
| Backend | Render web service (root directory `backend/`), free plan | https://gazemetrics.onrender.com | The API; it also serves a copy of the frontend |
| Database | Supabase (PostgreSQL) | — | All sessions and gaze data |

`frontend/config.js` decides where API calls go: same origin on `localhost` and on the Render address, and `https://gazemetrics.onrender.com` everywhere else (i.e. on Vercel).

The Render free plan puts the backend to sleep after about 15 minutes without requests. The Vercel pages load immediately and wake the backend in the background, but the first request after a sleep can still take up to a minute.

## What a participant does

1. **Consent and name** — agrees to the study and types a name, nickname or ID.
2. **Camera check** — the page reports a blocked, missing or busy camera instead of continuing.
3. **Face positioning** — a live camera preview with a square that turns green when both eyes are detected.
4. **Calibration** — 18 black dots (6 × 3 grid, 12 px, light gray background), each clicked 5 times.
5. **Accuracy check** — a dot moves through the same 18 positions, 3 seconds each; the average error is shown as Good / Fair / Poor, with the option to recalibrate.
6. **Test** — the exam pages are shown one question per page while gaze is recorded about 10 times per second.

The 18-point layout, target size and colours follow Psarra, Krassanakis and Kesidis, *Systematic Performance Evaluation of WebGazer Webcam-Based Eye Tracking with Spatial and Angular Error Analysis*, J. Eye Mov. Res. 2026, 19, 99 (https://doi.org/10.3390/jemr19050099). The settings are constants at the top of `frontend/eyetracker.js`.

## What is stored

| Table | One row per | Main columns |
|---|---|---|
| `gazepoint_sessions` | capture session | `participant_name`, `user_id`, browser size, `created_at` |
| `gazepoint_data` | 50 gaze samples, packed as arrays | `x_values`, `y_values`, `timestamps`, `html_element_ids` |
| `validation_points` | accuracy-check point, per attempt | `attempt`, `point_index`, `target_x`, `target_y`, `mean_error_px`, `sample_count` |
| `page_visits` | exam page shown | `page_id`, `question_id`, `entered_at`, `left_at`, `entered_elapsed`, `duration_seconds` |
| `fixation_points` | fixation, after processing | `x`, `y`, `duration`, `timestamp` |

- Read gaze samples through the `gazepoint_data_flat` view, which gives one row per sample with the question or answer element (`html_element_id`) the gaze landed on.
- Gaze `timestamp` and `page_visits.entered_elapsed` are both seconds since the participant clicked "Start recording", so they can be lined up.
- `page_visits.duration_seconds` is the time spent on that page, which is the time spent on that question.
- Clock times are stored in UTC.
- No video or images are stored; the camera feed is processed in the browser.

Tables and new columns are created automatically when the backend starts.

## Looking at the data

In Supabase, use **Table Editor** to browse tables or **SQL Editor** to run queries, for example:

```sql
-- Recent sessions, in Pacific time
SELECT id, participant_name,
       created_at AT TIME ZONE 'America/Los_Angeles' AS created_local
FROM gazepoint_sessions ORDER BY id DESC LIMIT 10;

-- Gaze samples for one session
SELECT x, y, timestamp, html_element_id
FROM gazepoint_data_flat WHERE session_id = 1 ORDER BY timestamp;

-- Time spent on each question
SELECT visit_index, page_id, question_id, duration_seconds
FROM page_visits WHERE session_id = 1 ORDER BY visit_index;

-- Calibration accuracy at each of the 18 points
SELECT attempt, point_index, target_x, target_y, mean_error_px, sample_count
FROM validation_points WHERE session_id = 1 ORDER BY attempt, point_index;
```

pgAdmin can also connect to the Supabase database using the details behind Supabase's **Connect** button.

## Local development

**1. Clone the repo**
```bash
git clone https://github.com/CPP-HAPII/GazeMetrics.git
cd GazeMetrics
```

**2. Install PostgreSQL** (if you don't have it) — https://www.postgresql.org/download/

**3. Create a local database and role**, using `psql` or pgAdmin's Query Tool:
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

**5. Create your `.env` file** in `backend/` (copy `.env.example`):
```
DATABASE_URL=postgresql+asyncpg://gazemetrics:gazemetrics@localhost:5432/gazemetrics
```

**6. Run it**
```bash
uvicorn main:app --reload --port 8000
```

Then open **http://localhost:8000/**. Use `localhost`, not `127.0.0.1`: WebGazer pops up an HTTPS warning on any other non-HTTPS address. Locally the backend serves the frontend itself, so nothing else needs to run, and your data goes to your local database, not to Supabase.

## Deploying changes

Push to `main` on GitHub.

- **Frontend** (`frontend/`): Vercel deploys every push automatically.
- **Backend** (`backend/`): Render deploys pushes that change `backend/`. Check the service's **Events** tab after pushing; if no deploy starts, use **Manual Deploy → Deploy latest commit**. A backend change is not live until that deploy finishes.
- **Database**: no manual step. The connection string is the `DATABASE_URL` environment variable on Render.

To check that the backend is awake and responding, open https://gazemetrics.onrender.com/api/health.

## Project layout

```
frontend/
  index.html              landing page
  capture.html, .css      consent, calibration and recording page
  eyetracker.js           capture logic: camera, calibration, accuracy check, gaze + page timing
  sample-page.html        exam page 1 (shown inside capture.html)
  sample-page-2.html      exam page 2
  viewer.html, .css       heatmap and fixation viewer
  heatmap.js              viewer logic
  config.js               backend address for the current host
backend/
  main.py                 FastAPI app and all /api routes
  requirements.txt
  .env.example
  utils/db/               database connection, tables and the flat view
  utils/*.py              ST-DBSCAN fixation pipeline
```

Exam pages must keep one question per page, with `id="page-N"` on the page section and `id="question-N"` / `id="answer-…"` on the question and answers. Gaze labelling and page timing both depend on those ids.

## Status

- ✅ Capture, 18-point calibration, per-point accuracy check, heatmap viewer
- ✅ PostgreSQL storage with batched writes, hosted on Supabase
- ✅ Participant name, page timing and time per question
- ✅ Frontend on Vercel, backend on Render
- 🚧 **In progress:** the full test interface (100 sequential multiple-choice questions, 20 with audio), replacing the two sample pages

## Notes and limitations

- **Accuracy is coarse.** WebGazer is webcam-based; on an 18-point check, average errors of a few hundred pixels are normal and match the paper above. The data separates broad areas of a page better than individual answer options. The Good / Fair / Poor limits (6% and 12% of the screen diagonal) were set for an earlier centre-only check and are strict for 18 points.
- **Error is stored in pixels**, not degrees; screen size and viewing distance are not collected.
- **The API has no login.** Anyone with the link can open the viewer and list sessions, including participant names.
- **The viewer shows the first exam page only** as the background for every session.
- **Fixation processing** needs at least 40 gaze points, and has not been verified on the hosted backend.
- A Chromium-based browser (Chrome, Edge) is recommended, at 100% zoom, with no other app using the camera.

## Requirements

- Python 3.11
- PostgreSQL
- A webcam

## Credits

This project builds directly on:
- [CPP-HAPII/EyeTrackingAnalysis](https://github.com/CPP-HAPII/EyeTrackingAnalysis) by Yong Thu La Wong — WebGazer/FastAPI/SQLite foundation, calibration flow, heatmap visualization, and ST-DBSCAN fixation pipeline
- WebGazer — https://webgazer.cs.brown.edu/
- heatmap.js — https://www.patrick-wied.at/static/heatmapjs/
- Fixation scripts adapted from CSULB BEACH-Gaze-Converter — https://github.com/TheD2Lab/BEACH-Gaze-Converter
