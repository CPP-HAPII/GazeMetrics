/*
 * Standalone WebGazer capture.
 *
 * Flow: load WebGazer -> create session -> 9-point calibration ->
 * poll gaze predictions -> batch-POST to the backend. Coordinates are stored in
 * viewport pixels; because the content fills the viewport, they map 1:1 to the
 * page the viewer will reproduce.
 */
(function () {
  "use strict";

  const DATAPOINTS_PER_SECOND = 10;
  const MAX_CACHE_SIZE = 20;
  const PARTICIPANT_KEY = "examParticipant:v1";
  const PAGE_NAME = "sample-page";
  const CAMERA_START_TIMEOUT_MS = 30000;

  // Backend may be hosted on a different origin than this static frontend
  // (see config.js); "" keeps requests same-origin for local dev.
  const API_BASE = window.API_BASE_URL || "";

  const browserWidth = window.innerWidth;
  const browserHeight = window.innerHeight;

  // DOM
  const contentFrame = document.getElementById("contentFrame");
  const loading = document.getElementById("loading");
  const loadingText = document.getElementById("loadingText");
  const cameraErrorBackdrop =document.getElementById("cameraErrorBackdrop");
  const cameraErrorText = document.getElementById("cameraErrorText");
  const cameraRetryBtn = document.getElementById("cameraRetryBtn");
  const position = document.getElementById("position");
  const previewSlot = document.getElementById("previewSlot");
  const positionDoneBtn = document.getElementById("positionDoneBtn");  const calib = document.getElementById("calib");
  const grid = document.getElementById("grid");
  const hudDot = document.getElementById("hudDot");
  const hudStatus = document.getElementById("hudStatus");
  const gazeDot = document.getElementById("gazeDot");
  const validate = document.getElementById("validate");
  const validateHint = document.getElementById("validateHint");
  const validateDot = document.getElementById("validateDot");
  const validateResult = document.getElementById("validateResult");
  const validateScore = document.getElementById("validateScore");
  const recalibrateBtn = document.getElementById("recalibrateBtn");
  const startRecordingBtn = document.getElementById("startRecordingBtn");

  // State
  let sessionId = null;
  let sessionReady = Promise.resolve();   // settles once session creation is done
  let participantName = "";
  let validationAttempt = 0;   // counts validation runs (recalibration repeats it)
  let currentVisit = null;     // the exam page currently on screen
  let visitIndex = 0;
  let examFinished = false;
  let dataCache = [];
  let calibrationFinish = false;
  let timeBegin = null;
  let logIntervalId = null;
  let started = false;

  const targets = [];
  // Calibration timing (see buildCalibrationGrid).
  const CALIB_HOLD_MS = 1000;             // how long a clicked dot shrinks while sampled
  const CALIB_SAMPLE_INTERVAL_MS = 50;    // one training sample per 50 ms (~20 per dot)
  const CALIB_GAP_MS = 250;               // pause before the next dot appears

  // Validation: show each evaluation point in turn, sample the prediction
  // while the user stares at it, and report the error so a bad calibration is
  // caught before recording. Per-point results are stored with the session.
  const VALIDATION_POINT_MS = 3000;    // how long each evaluation point is shown
  const VALIDATION_WARMUP_MS = 800;    // ignore the eye travelling to the point
  const VALIDATION_INTERVAL_MS = 50;   // ~20 samples/s
  // Error thresholds as a fraction of the viewport diagonal.
  const GOOD_FRAC = 0.06;
  const FAIR_FRAC = 0.12;

  // 18 calibration/evaluation positions (6 x 3 grid) as viewport percentages,
  // following Psarra et al. (J. Eye Mov. Res. 2026, 19, 99), where the 18-18
  // fixed layout gave the lowest error. Edge points sit close to the borders
  // (with a small margin) so WebGazer trains where it's weakest.
  const POINT_COLUMNS = [6, 23.6, 41.2, 58.8, 76.4, 94];
  const POINT_ROWS = [8, 50, 92];
  const POINT_POSITIONS = POINT_ROWS.flatMap((y) => POINT_COLUMNS.map((x) => [x, y]));

  /* ---------------- participant ---------------- */

  // The ID typed on the landing page, passed in the URL (and in sessionStorage
  // as a backup).
  function readParticipantId() {
    let id = new URLSearchParams(window.location.search).get("id");
    if (!id) {
      try { id = sessionStorage.getItem("participantId"); } catch { /* ignore */ }
    }
    return (id || "").trim();
  }

  // The exam keeps its progress for the life of the tab, so a reload resumes
  // where it was. On a shared computer the next participant must not inherit
  // that, so a different name starts the exam over.
  function resetExamIfNewParticipant() {
    const name = participantName.toLowerCase();
    try {
      if (sessionStorage.getItem(PARTICIPANT_KEY) === name) return;
      contentFrame.contentWindow.resetExam();
      sessionStorage.setItem(PARTICIPANT_KEY, name);
    } catch { /* ignore */ }
  }

  // resetExam only exists once the exam inside the iframe has loaded.
  function whenExamReady(fn) {
    try {
      if (contentFrame.contentWindow.resetExam) { fn(); return; }
    } catch { /* ignore */ }
    contentFrame.addEventListener("load", fn, { once: true });
  }

  /* ---------------- webgazer loading ---------------- */

  function loadWebGazer() {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/webgazer@3.4.0/dist/webgazer.min.js";
      script.onload = () => resolve(window.webgazer);
      script.onerror = () => reject(new Error("Failed to load WebGazer"));
      document.head.appendChild(script);
    });
  }

  // Block the page with a plain-language reason when the webcam can't start
  // (error names are the standard getUserMedia ones).
  function showCameraError(e) {
    const name = e && e.name;
    let msg;
    if (name === "NotAllowedError") {
      msg = "Camera access is blocked for this site. Allow the camera in your browser's address bar, then try again.";
    } else if (name === "NotFoundError") {
      msg = "No camera was found on this device.";
    } else if (name === "NotReadableError") {
      msg = "The camera is being used by another app or browser tab. Close it, then try again.";
    } else {
      msg = "The camera did not start. Allow camera access if asked, close other apps using the camera, then try again.";
    }
    hudStatus.textContent = "Camera unavailable";
    cameraErrorText.textContent = msg;
    cameraErrorBackdrop.classList.add("show");
  }

  /* ---------------- backend calls ---------------- */

  async function createSession() {
    const res = await fetch(API_BASE + "/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        participant_name: participantName,
        page_name: PAGE_NAME,
        browser_width: browserWidth,
        browser_height: browserHeight,
      }),
    });
    const json = await res.json();
    sessionId = json.session_id;
  }

  // A failed request (e.g. a network hiccup) is retried a few times before
  // giving up, since nothing is saved without a session.
  async function createSessionWithRetry() {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await createSession();
        if (sessionId != null) return;
      } catch (e) {
        console.error("Failed to create session (attempt " + attempt + ")", e);
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  async function flushCache() {
    if (dataCache.length === 0) return;
    const batch = dataCache;
    dataCache = [];
    try {
      await fetch(API_BASE + "/api/points", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points: batch }),
      });
    } catch (e) {
      console.error("Failed to store points", e);
    }
  }

  // Save the per-point accuracy of one validation run. Best-effort: a failed
  // save must not stop the participant from starting.
  async function storeValidation(points) {
    await sessionReady;
    if (sessionId == null) return;
    try {
      await fetch(API_BASE + "/api/validation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, attempt: validationAttempt, points }),
      });
    } catch (e) {
      console.error("Failed to store validation", e);
    }
  }

  /* ---------------- face positioning ---------------- */

  // Before calibrating, show WebGazer's live camera preview with its face
  // feedback box (green once both eyes are inside it), so the participant can
  // fix their position/lighting first. The preview is hidden again afterwards.
  function setCameraPreview(visible) {
    try {
      window.webgazer
        .showVideo(visible)
        .showFaceOverlay(visible)
        .showFaceFeedbackBox(visible);
    } catch { /* ignore */ }
  }

  function startPositioning() {
    hudStatus.textContent = "Checking camera…";
    position.classList.add("show");
    loading.classList.remove("show");
    // WebGazer pins its preview to the top-left corner; move it into the
    // slot in our overlay and lift it above the overlay.
    const container = document.getElementById("webgazerVideoContainer");
    if (container) {
      const rect = previewSlot.getBoundingClientRect();
      container.style.left = rect.left + "px";
      container.style.top = rect.top + "px";
      container.style.zIndex = "125";
    }
    setCameraPreview(true);
  }

  function finishPositioning() {
    setCameraPreview(false);
    position.classList.remove("show");
    hudStatus.textContent = "Calibrating…";
    calib.classList.add("show");
    buildCalibrationGrid();
  }

  /* ---------------- calibration ---------------- */

  // Calibration shows one dot at a time, as in Psarra et al. The participant
  // clicks it (which makes sure they are looking at it), then keeps looking
  // while it shrinks away. WebGazer gets a training sample at the click and
  // every CALIB_SAMPLE_INTERVAL_MS while it shrinks: about 20 clean samples
  // per point, instead of a few rapid clicks with all dots on screen at once,
  // when the eyes may already be moving on to the next dot.
  function buildCalibrationGrid() {
    grid.innerHTML = "";
    targets.length = 0;

    for (let i = 0; i < POINT_POSITIONS.length; i++) {
      const [xPct, yPct] = POINT_POSITIONS[i];
      const cell = document.createElement("div");
      cell.className = "target";
      cell.style.left = xPct + "%";
      cell.style.top = yPct + "%";
      const dot = document.createElement("div");
      cell.appendChild(dot);
      // The click target is the padded cell, not the 12px dot, so the small
      // dot is still easy to hit.
      cell.addEventListener("click", onTargetClick);
      grid.appendChild(cell);
      targets.push(cell);
    }
    showTarget(0);
  }

  function showTarget(index) {
    targets.forEach((t, i) => t.classList.toggle("active", i === index));
  }

  function onTargetClick(e) {
    e.stopPropagation();
    const cell = e.currentTarget;
    if (!cell.classList.contains("active") || cell.classList.contains("collecting")) return;
    cell.classList.add("collecting");   // starts the shrink animation (capture.css)

    // Train WebGazer on the dot's true screen position (not the raw cursor
    // point). Measured before shrinking; scaling keeps the same centre.
    const rect = cell.firstChild.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const record = () => {
      try { window.webgazer.recordScreenPosition(cx, cy, "click"); } catch { /* ignore */ }
    };
    record();
    const sampleTimer = setInterval(record, CALIB_SAMPLE_INTERVAL_MS);

    setTimeout(() => {
      clearInterval(sampleTimer);
      cell.classList.remove("active", "collecting");
      const next = targets.indexOf(cell) + 1;
      if (next < targets.length) {
        setTimeout(() => showTarget(next), CALIB_GAP_MS);
      } else {
        startValidation();
      }
    }, CALIB_HOLD_MS);
  }

  /* ---------------- validation ---------------- */

  // Show each evaluation point in turn, sample predictions while it is
  // visible, and report the mean distance from the points. Lets the user
  // recalibrate before recording.
  function startValidation() {
    calib.classList.remove("show");
    validateResult.classList.remove("show");
    validateHint.style.visibility = "visible";
    validateDot.style.display = "block";
    validate.classList.add("show");
    validationAttempt += 1;

    const points = [];
    const allErrors = [];

    function runPoint(index) {
      const [xPct, yPct] = POINT_POSITIONS[index];
      validateDot.style.left = xPct + "%";
      validateDot.style.top = yPct + "%";
      const rect = validateDot.getBoundingClientRect();
      const targetX = rect.left + rect.width / 2;
      const targetY = rect.top + rect.height / 2;

      const errors = [];
      const startedAt = Date.now();
      let finished = false;
      const sampleTimer = window.setInterval(async () => {
        let data = null;
        try {
          data = await window.webgazer.getCurrentPrediction();
        } catch { /* ignore */ }
        // The await above lets ticks overlap, so a late one may land after
        // this point has already been closed.
        if (finished) return;
        const elapsed = Date.now() - startedAt;
        if (elapsed > VALIDATION_WARMUP_MS && data) {
          errors.push(Math.hypot(data.x - targetX, data.y - targetY));
        }
        if (elapsed >= VALIDATION_POINT_MS) {
          finished = true;
          clearInterval(sampleTimer);
          points.push({
            point_index: index,
            target_x: Math.round(targetX),
            target_y: Math.round(targetY),
            mean_error_px: errors.length
              ? errors.reduce((a, b) => a + b, 0) / errors.length
              : null,
            sample_count: errors.length,
          });
          allErrors.push(...errors);
          if (index + 1 < POINT_POSITIONS.length) {
            runPoint(index + 1);
          } else {
            validateDot.style.display = "none";
            storeValidation(points);
            showValidationResult(allErrors);
          }
        }
      }, VALIDATION_INTERVAL_MS);
    }

    runPoint(0);
  }

  function showValidationResult(samples) {
    validateHint.style.visibility = "hidden";
    const diag = Math.hypot(browserWidth, browserHeight);

    let grade, cls, detail;
    if (samples.length === 0) {
      grade = "No signal";
      cls = "poor";
      detail = "WebGazer couldn't read your gaze. Check lighting and that your face is visible, then recalibrate.";
    } else {
      const meanPx = samples.reduce((a, b) => a + b, 0) / samples.length;
      const frac = meanPx / diag;
      if (frac <= GOOD_FRAC) { grade = "Good"; cls = "good"; }
      else if (frac <= FAIR_FRAC) { grade = "Fair"; cls = "fair"; }
      else { grade = "Poor"; cls = "poor"; }
      detail = "Average error over " + POINT_POSITIONS.length + " points: ~" +
        Math.round(meanPx) + " px (" +
        (frac * 100).toFixed(1) + "% of screen). " +
        (cls === "good"
          ? "You're good to go."
          : "Recalibrate for better results — keep your head still and click each dot while looking right at it.");
    }

    validateScore.innerHTML =
      'Calibration accuracy: <span class="grade ' + cls + '">' + grade + "</span><br>" + detail;
    validateResult.classList.add("show");
  }

  function finishCalibration() {
    validate.classList.remove("show");
    calib.classList.remove("show");
    contentFrame.style.visibility = "visible";   // the exam is shown only now
    // Hand keyboard focus to the exam: otherwise the hidden "Start recording"
    // button keeps it, and the space bar would press it again.
    try { document.activeElement.blur(); } catch { /* ignore */ }
    try { contentFrame.contentWindow.focus(); } catch { /* ignore */ }
    listenForExamClicks();
    calibrationFinish = true;
    // Recording starts now: gaze timestamps and page-visit times are both
    // measured from this moment, so they can be lined up afterwards.
    timeBegin = Date.now();
    openVisit();
    hudDot.classList.add("recording");
    hudStatus.textContent = "Recording gaze";
    gazeDot.classList.add("show");   // reveal the live gaze dot
  }

  // Move the red dot to the latest prediction. Runs at WebGazer's full
  // prediction rate (~30/s) — smoother than the 10/s storage loop — and only
  // after calibration, so it never appears during setup.
  function moveGazeDot(data) {
    if (!calibrationFinish || !data) return;
    gazeDot.style.transform =
      "translate(" + data.x + "px, " + data.y + "px)";
  }

  /* ---------------- page timing ---------------- */

  // One "visit" per exam page shown in the iframe: which page/question it
  // was, when it appeared, and how long it stayed. Each exam page holds one
  // question, so the visit duration is the time spent on that question.
  function describeFramePage() {
    let doc = null;
    let examPage = null;
    try {
      doc = contentFrame.contentDocument;
      examPage = contentFrame.contentWindow.currentExamPage || null;
    } catch { /* ignore */ }
    const page_url = doc ? doc.location.pathname.split("/").pop() : null;

    // exam.js renders every page into one document and reports which one is
    // showing; directions and reading-passage pages have no question.
    if (examPage) {
      return {
        page_id: examPage.id,
        question_id: examPage.type === "directions" || examPage.type === "reading" ? null : examPage.id,
        page_url,
      };
    }
    // Pages that are separate HTML files (the sample pages) are identified by
    // their id="page-N" / id="question-N" elements.
    const pageEl = doc && doc.querySelector('[id^="page-"]');
    const questionEl = doc && doc.querySelector('[id^="question-"]');
    return {
      page_id: pageEl ? pageEl.id : null,
      question_id: questionEl ? questionEl.id : null,
      page_url,
    };
  }

  function openVisit() {
    visitIndex += 1;
    currentVisit = { ...describeFramePage(), visit_index: visitIndex, enteredAt: Date.now() };
  }

  // End the current visit and return it in the shape the backend stores.
  function closeVisit() {
    if (!currentVisit || sessionId == null) return null;
    const visit = currentVisit;
    currentVisit = null;
    const now = Date.now();
    return {
      session_id: sessionId,
      visit_index: visit.visit_index,
      page_id: visit.page_id,
      question_id: visit.question_id,
      page_url: visit.page_url,
      entered_at: new Date(visit.enteredAt).toISOString(),
      left_at: new Date(now).toISOString(),
      entered_elapsed: (visit.enteredAt - timeBegin) / 1000,
      duration_seconds: (now - visit.enteredAt) / 1000,
    };
  }

  // keepalive lets the request finish even if the tab is closing.
  async function sendVisit(visit, keepalive = false) {
    if (!visit) return;
    try {
      await fetch(API_BASE + "/api/page-visits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(visit),
        keepalive,
      });
    } catch (e) {
      console.error("Failed to store page visit", e);
    }
  }

  // The previous page's visit ends and the new one begins. Changes before
  // recording starts (the first page sits behind the positioning/calibration
  // overlays) and after the exam ends are ignored.
  function onPageChanged() {
    if (!calibrationFinish || examFinished) return;
    sendVisit(closeVisit());
    openVisit();
  }

  // Called by exam.js each time it shows a new page.
  window.onExamPageShown = onPageChanged;

  // Pages that are separate HTML files change by loading a new document.
  // exam.js pages report their changes above instead, so skip those here.
  contentFrame.addEventListener("load", () => {
    listenForExamClicks();   // a newly loaded page needs the listener again
    try {
      if (contentFrame.contentWindow.startExam) return;
    } catch { /* ignore */ }
    onPageChanged();
  });

  /* ---------------- learning from clicks during the test ---------------- */

  // During the test every mouse click is also a training sample: people look
  // at what they click (an answer, the Next button), so WebGazer keeps
  // adjusting as the participant shifts in their seat over a long test.
  // Mouse movement is still ignored, and keyboard "clicks" (no position)
  // are skipped.
  function onExamClick(e) {
    if (!calibrationFinish || examFinished || e.detail === 0) return;
    const frameRect = contentFrame.getBoundingClientRect();
    try {
      window.webgazer.recordScreenPosition(e.clientX + frameRect.left, e.clientY + frameRect.top, "click");
    } catch { /* ignore */ }
  }

  // Safe to call repeatedly: the same listener is only added once per page.
  function listenForExamClicks() {
    try { contentFrame.contentDocument.addEventListener("click", onExamClick, true); } catch { /* ignore */ }
  }

  /* ---------------- gaze logging ---------------- */

  function inBounds(x, y, threshold = 6) {
    return (
      x > threshold &&
      x < browserWidth - threshold &&
      y > threshold &&
      y < browserHeight - threshold
    );
  }

  // Nearest-edge distance from (x, y) to an element's box — 0 if the point is
  // already inside it. Used instead of center-distance so a small element
  // right next to the point isn't out-ranked by a large one whose center
  // happens to be closer.
  function distanceToRect(rect, x, y) {
    const dx = Math.max(rect.left - x, 0, x - rect.right);
    const dy = Math.max(rect.top - y, 0, y - rect.bottom);
    return Math.hypot(dx, dy);
  }

  const FALLBACK_RADIUS = 18; // px — matches typical post-calibration WebGazer jitter

  // Fallback for gaze that lands in an un-id'd gap (e.g. the flex gaps
  // between answer options, which only bubble up to the whole-page
  // container via closest("[id]")): probe a small radius around the point
  // for the nearest id'd block inside that container (prompt, audio block,
  // answer option, button) and use that instead.
  function nearestLabeledElement(container, x, y, radius) {
    const candidates = container.querySelectorAll("[id]");
    let best = null;
    let bestDist = Infinity;
    for (const candidate of candidates) {
      const dist = distanceToRect(candidate.getBoundingClientRect(), x, y);
      if (dist < bestDist) {
        bestDist = dist;
        best = candidate;
      }
    }
    return bestDist <= radius ? best : null;
  }

  async function logPoint() {
    if (!calibrationFinish || sessionId == null) return;
    const data = await window.webgazer.getCurrentPrediction();
    if (!data) return;
    if (!inBounds(data.x, data.y)) return;

    if (!timeBegin) timeBegin = Date.now();
    const timeElapsed = (Date.now() - timeBegin) / 1000;

    // The exam content fills the viewport inside #contentFrame, so a hit on
    // the top document resolves to the iframe itself. Coordinates map 1:1,
    // so re-run the hit test inside the iframe's own document to find the
    // actual question/answer element the gaze landed on.
    let el = document.elementFromPoint(data.x, data.y);
    let frameDoc = null;
    if (el === contentFrame) {
      frameDoc = contentFrame.contentDocument;
      try {
        const frameEl = frameDoc.elementFromPoint(data.x, data.y);
        if (frameEl) el = frameEl;
      } catch { /* ignore */ }
    }
    // elementFromPoint returns the innermost element at that pixel (e.g. a
    // <p> or <label> with no id), so walk up to the nearest ancestor that
    // actually has one (the question/answer block).
    const idEl = el && el.closest ? el.closest("[id]") : el;

    // closest("[id]") only found a container (the whole page, or a reading
    // passage when the gaze falls between words or lines), because the gap
    // has no id of its own — try the radius fallback to find the nearest
    // block or word before giving up the detail.
    let html_element_id = idEl ? idEl.id : null;
    if (frameDoc && idEl && (idEl.classList.contains("card") || idEl.classList.contains("reading-text"))) {
      const nearest = nearestLabeledElement(idEl, data.x, data.y, FALLBACK_RADIUS);
      if (nearest) html_element_id = nearest.id;
    }

    dataCache.push({
      session_id: sessionId,
      x: parseInt(data.x, 10),
      y: parseInt(data.y, 10),
      timestamp: timeElapsed,
      html_element_id,
    });

    if (dataCache.length >= MAX_CACHE_SIZE) flushCache();
  }

  /* ---------------- start ---------------- */

  async function startFlow() {
    if (started) return;
    started = true;

    hudStatus.textContent = "Loading eye tracker…";
    try {
      await loadWebGazer();

      // begin() resolves once the webcam is delivering frames and rejects if
      // the camera is blocked/busy. Wait for it (with a timeout, in case no
      // frame ever arrives) so a dead camera is reported here instead of
      // surfacing later as "No signal" after a full calibration.
      try {
        await Promise.race([
          window.webgazer
            .showVideo(false)
            .showFaceOverlay(false)
            .showFaceFeedbackBox(false)
            .showPredictionPoints(false)
            .applyKalmanFilter(true)   // smooth out prediction jitter
            // WebGazer otherwise reloads calibration samples saved by earlier
            // visits in this browser — a different sitting position, or a
            // different person — and mixes them into the new model.
            .saveDataAcrossSessions(false)
            .setGazeListener(function (data) { moveGazeDot(data); })
            .begin(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Camera start timed out")), CAMERA_START_TIMEOUT_MS)
          ),
        ]);
      } catch (e) {
        console.error(e);
        showCameraError(e);
        return;
      }

      // By default WebGazer trains on every mouse click AND mouse-move, which
      // biases the model toward the cursor. Drop the global listeners so it only
      // learns from our deliberate calibration clicks (via recordScreenPosition).
      // (begin() adds them, so this must run after it has finished.)
      try { window.webgazer.removeMouseEventListeners(); } catch { /* ignore */ }

      // Wipe any samples an earlier visit left in this browser's storage.
      try { await window.webgazer.clearData(); } catch { /* ignore */ }

      // Only create the session once the camera works, so failed starts don't
      // leave empty sessions behind. Don't wait for it, though: a sleeping
      // backend can take up to a minute to answer, and positioning plus
      // calibration take longer than that. Gaze logging starts by itself
      // once the session id arrives; the accuracy save waits for it.
      sessionReady = createSessionWithRetry();

      startPositioning();

      logIntervalId = window.setInterval(logPoint, 1000 / DATAPOINTS_PER_SECOND);
    } catch (e) {
      console.error(e);
      hudStatus.textContent = "Error starting eye tracker";
      loadingText.textContent = "Error starting eye tracker";
    }
  }

  function endWebgazer() {
    if (logIntervalId) clearInterval(logIntervalId);
    try {
      window.webgazer?.pause?.();
      // end() only pauses tracking and removes UI elements — it does not
      // release the camera. stopVideo() is what actually stops the media
      // stream track (turns off the camera).
      window.webgazer?.stopVideo?.();
      window.webgazer?.clearData?.();
      window.webgazer?.end?.();
    } catch {
      /* ignore */
    }
  }

  /* ---------------- wiring ---------------- */

  startRecordingBtn.addEventListener("click", () => {
    finishCalibration();
  });

  recalibrateBtn.addEventListener("click", () => {
    validate.classList.remove("show");
    validateResult.classList.remove("show");
    try { window.webgazer.clearData(); } catch { /* ignore */ }
    // A poor result is most often a badly placed face, so check that first.
    startPositioning();
  });

  positionDoneBtn.addEventListener("click", finishPositioning);
  // Called by the exam content (via window.parent.finishExam()) when the
  // user submits the last question — saves remaining points and stops
  // WebGazer.
  window.finishExam = async function () {
    hudStatus.textContent = "Saving…";
    examFinished = true;
    await sendVisit(closeVisit());
    await flushCache();
    endWebgazer();
    hudStatus.textContent = "Submitted";
  };

  window.addEventListener("beforeunload", () => {
    // Best-effort flush of the open page visit and remaining points on tab
    // close. fetch+keepalive rather than sendBeacon: a beacon always sends
    // credentials, which the backend's wildcard CORS policy rejects when the
    // frontend is hosted on a different origin.
    sendVisit(closeVisit(), true);
    if (dataCache.length && sessionId != null) {
      fetch(API_BASE + "/api/points", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points: dataCache }),
        keepalive: true,
      }).catch(() => { /* ignore */ });
    }
    endWebgazer();
  });

  cameraRetryBtn.addEventListener("click", () => window.location.reload());

  // The space bar ends a reading passage. If the key press lands on this page
  // instead of the exam inside the iframe, pass it on.
  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space" && e.key !== " ") return;
    let win = null;
    try { win = contentFrame.contentWindow; } catch { /* ignore */ }
    if (!calibrationFinish || !win || !win.currentExamPage || win.currentExamPage.type !== "reading") return;
    e.preventDefault();
    if (!e.repeat) win.advanceReading();
  });

  // On load: every session needs a participant ID, which comes from the
  // landing page. Without one, send the participant there to enter it.
  participantName = readParticipantId();
  if (!participantName) {
    window.location.replace("landing.html");
    return;
  }
  whenExamReady(resetExamIfNewParticipant);
  startFlow();
})();
