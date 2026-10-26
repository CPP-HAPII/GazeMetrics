# GazeMetrics

Webcam eye-tracking platform for a language-assessment research study, built on top of the WebGazer + FastAPI foundation from [CPP-HAPII/EyeTrackingAnalysis](https://github.com/CPP-HAPII/EyeTrackingAnalysis).

This fork adapts the original standalone demo into the assessment system used for the CaMLA English Placement Test (EPT) eye-tracking study, run by the CPP-HAPII lab.

## Live site

**https://gazemetrics-frontend.vercel.app/**

Opening this link goes straight to the welcome page, where the participant enters their ID. The viewer for recorded sessions is at `/viewer.html`.

Share this link, not the Render address below and not a link that has extra characters after `gazemetrics-frontend` (those point at one old deployment and ask for a Vercel login).

## Tech stack

| Layer | Technology | Framework? |
|---|---|---|
| Frontend | HTML, CSS and plain ("vanilla") JavaScript | No framework (no React etc.): every page is a hand-written HTML file in `frontend/` |
| Eye tracking | [WebGazer.js](https://webgazer.cs.brown.edu/) 3.4, loaded from a CDN | A library, used from `frontend/eyetracker.js` |
| Heatmaps | [heatmap.js](https://www.patrick-wied.at/static/heatmapjs/) 2.0 | A library, used by the viewer |
| Backend | Python 3.11 with **FastAPI**, run by **Uvicorn** | Yes: FastAPI is the web framework for all `/api` routes (`backend/main.py`) |
| Database access | SQLAlchemy 2.0 (async) with asyncpg; Pydantic for data shapes | |
| Database | PostgreSQL, hosted on Supabase | |
| Fixation analysis | pandas, NumPy, SciPy, scikit-learn, kneed (ST-DBSCAN pipeline) | |

**Why two languages:** the eye tracking has to run in the participant's browser, where the webcam is, and browsers only run JavaScript. Saving the data and analysing it happen on the server, where Python has the stronger data tools (and the fixation scripts this project builds on are Python). The browser sends only gaze coordinates and timings to the backend; no camera images or video ever leave the browser.

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

The Render free plan puts the backend to sleep after about 15 minutes without requests. The welcome page starts waking it while the participant types their ID, and the calibration screens don't wait for it: they take longer than the backend needs to wake, and the session is saved as soon as it answers.

## What a participant does

1. **Welcome page** (`landing.html`) — enters their ID.
2. **Start page** (`index.html`) — clicks **Calibrate & Capture**.
3. **Camera check** — the page reports a blocked, missing or busy camera instead of continuing.
4. **Face positioning** — a live camera preview with a square that turns green when both eyes are detected.
5. **Calibration** — 18 black dots (6 × 3 grid, 12 px, light gray background), shown one at a time. The participant clicks each dot, then keeps looking at it while it shrinks for 1 second; the tracker records a training sample every 50 ms during that time (about 21 per dot).
6. **Accuracy check** — a dot moves through the same 18 positions, 3 seconds each; the average error is shown as Good / Fair / Poor, with the option to recalibrate.
7. **Test** — gaze is recorded about 10 times per second (see [The test](#the-test)). The participant does not see where the tracker thinks they are looking (the live gaze dot is hidden, so it can't draw their eyes). Every mouse click during the test also trains the tracker, since people look at what they click; this keeps it adjusting as the participant shifts over a long test.

The 18-point layout, target size and colours, and the one-dot-at-a-time calibration, follow Psarra, Krassanakis and Kesidis, *Systematic Performance Evaluation of WebGazer Webcam-Based Eye Tracking with Spatial and Angular Error Analysis*, J. Eye Mov. Res. 2026, 19, 99 (https://doi.org/10.3390/jemr19050099). The settings are constants at the top of `frontend/eyetracker.js`.

### Testing shortcuts

The start page has two extra links for the team:

- **Skip calibration** — opens the test from question 1 on its own, with no camera and nothing saved. Useful for checking how pages look.
- **Skip to reading tasks (testing)** — the same, but opening at the reading instructions, so the reading section can be checked without going through the first 100 questions.

Any test page can be opened directly with `?start=<page id>`, e.g. `exam1.html?start=passage-5`. To test the reading section **with** eye tracking and saved data, add it to the capture page instead: `capture.html?id=<your ID>&start=reading-directions`.

Remove the two links before real participants use the site.

## The test

Defined in `frontend/exam1.html` and rendered one page at a time by `frontend/exam.js`, inside the capture page.

| Section | Pages |
|---|---|
| Listening Comprehension | directions with an audio example, then 20 audio questions (each clip plays only once) |
| Grammar, Vocabulary, and Reading Comprehension | 3 directions pages, then 80 text questions (questions 21–100) |
| Reading | directions, then 12 passages; each passage is followed by its 2 questions on separate pages (questions 101–124) |

Questions can't be revisited once answered. A reload resumes on the same page; a different participant ID starts from the beginning.

**Reading passages** (from `MECOL2.xlsx`, stored in `frontend/reading-tasks.js`) follow the supervisor's spec: Consolas 20pt, 1.5 line spacing, nothing else on screen, and the **space bar** (not a button) ends the passage, as explained on the reading directions page. Each passage's width is fitted so it wraps to about 10 lines; this works from about a 1920×960 browser window, and smaller windows wrap to more lines.

### Gaze labels

Every gaze sample is saved with the id of the element it landed on (`html_element_id`). Every word on every page has its own id saying where it is:

| Example id | Meaning |
|---|---|
| `passage-3-l2-w17` | reading passage 3, line 2, word 17 |
| `q95-passage-l1-w12` | question 95, its short passage, word 12 |
| `q95-question-l1-w3` | question 95, the question itself, word 3 |
| `q95-a-l1-w2` | question 95, answer a, word 2 |
| `q1-play`, `q1-number`, `q1-counter`, `q1-btn` | Play button, question number, "Question x of y" counter, Next button |
| `listening-directions-body-l5-w60` | a word in the directions text |

The part before `-l` names the block a word belongs to (passage, question, answer a…), so results can be grouped by word, line or block. Line numbers are saved as they were on the participant's screen, since line breaks depend on screen size. A look that falls in a gap between words or blocks is saved as the nearest labelled word or block within 18 pixels.

## What is stored

| Table | One row per | Main columns |
|---|---|---|
| `gazepoint_sessions` | capture session | `participant_name`, `user_id`, browser size, `created_at` |
| `gazepoint_data` | 50 gaze samples, packed as arrays | `x_values`, `y_values`, `timestamps`, `html_element_ids` |
| `validation_points` | accuracy-check point, per attempt | `attempt`, `point_index`, `target_x`, `target_y`, `mean_error_px`, `sample_count` |
| `page_visits` | exam page shown | `page_id`, `question_id`, `entered_at`, `left_at`, `entered_elapsed`, `duration_seconds` |
| `fixation_points` | fixation, after processing | `x`, `y`, `duration`, `timestamp` |

- Read gaze samples through the `gazepoint_data_flat` view, which gives one row per sample with the element it landed on (`html_element_id`, see [Gaze labels](#gaze-labels)) and the session's `participant_name`.
- Gaze `timestamp` and `page_visits.entered_elapsed` are both seconds since the participant clicked "Start recording", so they can be lined up.
- `page_visits` has one row per page shown, using the test's page ids (`q1` … `q100`, `passage-1`, `passage-1-q1`, …). `duration_seconds` is the time on that page: time per question on question pages, reading time on passage pages. `question_id` is empty for directions and reading-passage pages.
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

-- Gaze samples for one participant
SELECT session_id, x, y, timestamp, html_element_id
FROM gazepoint_data_flat WHERE participant_name = 'P001' ORDER BY session_id, timestamp;

-- Time spent on each page (questions, passages, directions)
SELECT visit_index, page_id, question_id, duration_seconds
FROM page_visits WHERE session_id = 1 ORDER BY visit_index;

-- Gaze samples per block of question 95 (passage, question, answers a-d)
SELECT split_part(html_element_id, '-l', 1) AS block, count(*) AS samples
FROM gazepoint_data_flat
WHERE session_id = 1 AND html_element_id LIKE 'q95-%'
GROUP BY block ORDER BY samples DESC;

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
  landing.html            welcome page: participant enters their ID
  index.html              start page: Calibrate & Capture, plus the testing shortcuts
  capture.html, .css      camera check, face positioning, calibration, accuracy check, recording
  eyetracker.js           capture logic: camera, calibration, accuracy check, gaze labels, page timing
  exam1.html              the test: page list for all sections
  exam.js, exam.css       renders one test page at a time; word ids, reading passages, space bar
  reading-tasks.js        the 12 reading passages and their 24 questions
  audio/                  listening section audio
  assets/                 logos
  viewer.html, .css       heatmap and fixation viewer
  heatmap.js              viewer logic
  config.js               backend address for the current host
  sample-page*.html       old sample pages, no longer used by the capture page
backend/
  main.py                 FastAPI app and all /api routes
  requirements.txt
  .env.example
  utils/db/               database connection, tables and the flat view
  utils/*.py              ST-DBSCAN fixation pipeline
```

To add or change test pages, edit the `PAGES` list in `exam1.html`; the page types are described at the top of `exam.js`. Give every page a unique `id`: page timing and gaze labels are built from it. The capture page learns about page changes from `exam.js` (`onExamPageShown`), so pages must be rendered by `exam.js` rather than loaded as separate HTML files.

## API

All routes are in `backend/main.py`. The capture page calls the first five; the viewer uses the rest.

| Method and path | Used for |
|---|---|
| `GET /api/health` | Check (and wake) the backend; touches no data |
| `POST /api/session` | Create a session with the participant's ID and browser size; returns `session_id` |
| `POST /api/points` | Save gaze samples (sent about every 2 seconds); written to the database in batches every 5 seconds |
| `POST /api/validation` | Save the 18 per-point results of an accuracy check |
| `POST /api/page-visits` | Save one page visit: which page, when it appeared, how long it stayed |
| `GET /api/sessions` | List sessions with point and fixation counts |
| `GET /api/session/{id}` | One session's details |
| `GET /api/points?session_id=` | A session's raw gaze samples |
| `POST /api/process` | Run the ST-DBSCAN fixation pipeline for a session |
| `GET /api/fixations?session_id=` | A session's processed fixations |

## Status

- ✅ Welcome page with participant ID; capture with face positioning, one-dot-at-a-time 18-point calibration and per-point accuracy check
- ✅ The full test: 20 listening questions, 80 written questions, 12 reading passages with 24 questions
- ✅ Word-level gaze labels on every page, page timing, time per question and reading time per passage
- ✅ Live gaze dot hidden from participants during the test
- ✅ PostgreSQL storage with batched writes, hosted on Supabase; frontend on Vercel, backend on Render
- 🚧 Open questions: saving participants' answers, an "End test" button, and updating the viewer to show the test pages

## Notes and limitations

- **Accuracy is coarse.** WebGazer is webcam-based; on an 18-point check, average errors of a few hundred pixels are normal and match the paper above. The data separates broad areas of a page better than individual words or answer options. The Good / Fair / Poor limits (6% and 12% of the screen diagonal) were set for an earlier centre-only check and are strict for 18 points.
- **Answers are not saved.** The test records gaze and time per page, but not which option the participant chose.
- **Small screens:** some question pages (e.g. question 91) cut off the Next button below about a 1920×960 browser window, and the pages can't scroll. Reading passages wrap to more than 10 lines on smaller windows.
- **Consolas** is a Windows font; on a Mac without it, reading passages fall back to Courier New, which is wider, so lines wrap differently.
- **Error is stored in pixels**, not degrees; screen size and viewing distance are not collected.
- **The API has no login.** Anyone with the link can open the viewer and list sessions, including participant names.
- **The viewer still shows the old sample page** as the background for every session, not the test page that was on screen.
- **Fixation processing** needs at least 40 gaze points, and has not been verified on the hosted backend.
- A Chromium-based browser (Chrome, Edge) is recommended, at 100% zoom, with no other app (Zoom, Teams, the Camera app) using the camera.

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
