/*
 * Standalone WebGazer capture.
 *
 * Flow: consent -> load WebGazer -> create session -> 9-point calibration ->
 * poll gaze predictions -> batch-POST to the backend. Coordinates are stored in
 * viewport pixels; because the content fills the viewport, they map 1:1 to the
 * page the viewer will reproduce.
 */
(function () {
  "use strict";

  const DATAPOINTS_PER_SECOND = 10;
  const MAX_CACHE_SIZE = 20;
  const CONSENT_KEY = "gazeConsent:v1";
  const PAGE_NAME = "sample-page";
  const CAMERA_START_TIMEOUT_MS = 30000;

  // Backend may be hosted on a different origin than this static frontend
  // (see config.js); "" keeps requests same-origin for local dev.
  const API_BASE = window.API_BASE_URL || "";

  const browserWidth = window.innerWidth;
  const browserHeight = window.innerHeight;

  // DOM
  const contentFrame = document.getElementById("contentFrame");
  const consentBackdrop = document.getElementById("consentBackdrop");
  const acceptBtn = document.getElementById("acceptBtn");
  const declineBtn = document.getElementById("declineBtn");
  const participantNameInput = document.getElementById("participantName");
  const participantNameError = document.getElementById("participantNameError");
  const cameraErrorBackdrop = document.getElementById("cameraErrorBackdrop");
  const cameraErrorText = document.getElementById("cameraErrorText");
  const cameraRetryBtn = document.getElementById("cameraRetryBtn");
  const position = document.getElementById("position");
  const previewSlot = document.getElementById("previewSlot");
  const positionDoneBtn = document.getElementById("positionDoneBtn");
  const calib = document.getElementById("calib");
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
  let participantName = "";
  let validationAttempt = 0;   // counts validation runs (recalibration repeats it)
  let dataCache = [];
  let calibrationFinish = false;
  let timeBegin = null;
  let logIntervalId = null;
  let started = false;

  const targets = [];
  // Each click adds one training sample for that screen position; 5 per point
  // is what WebGazer's own calibration uses.
  const CLICKS_PER_TARGET = 5;

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

  /* ---------------- consent ---------------- */

  function setConsent(granted) {
    localStorage.setItem(CONSENT_KEY, JSON.stringify({ granted: !!granted, ts: Date.now() }));
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
      cell.dataset.count = "0";

      // The click target is the padded cell, not the 12px dot, so the small
      // dot is still easy to hit.
      cell.addEventListener("click", (e) => {
        e.stopPropagation();
        // Train WebGazer on the dot's true screen position (not the raw cursor
        // point), so every click is a clean calibration sample.
        const rect = dot.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        try {
          window.webgazer.recordScreenPosition(cx, cy, "click");
        } catch { /* ignore */ }

        const c = parseInt(cell.dataset.count, 10) + 1;
        cell.dataset.count = String(c);
        dot.style.transform = "scale(1.5)";
        setTimeout(() => (dot.style.transform = "scale(1)"), 100);
        if (c >= CLICKS_PER_TARGET) cell.classList.add("done");
        if (targets.every((t) => parseInt(t.dataset.count, 10) >= CLICKS_PER_TARGET)) {
          startValidation();
        }
      });

      grid.appendChild(cell);
      targets.push(cell);
    }
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
    calibrationFinish = true;
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
  // for the nearest question/answer block and use that instead.
  function nearestLabeledElement(doc, x, y, radius) {
    const candidates = doc.querySelectorAll('[id^="question-"], [id^="answer-"]');
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

    // closest("[id]") only found the whole-page container (id'd elements
    // like question-*/answer-* skipped because the gap between them has no
    // id of its own) — try the radius fallback before giving up the detail.
    let html_element_id = idEl ? idEl.id : null;
    if (frameDoc && idEl && idEl.classList.contains("card")) {
      const nearest = nearestLabeledElement(frameDoc, data.x, data.y, FALLBACK_RADIUS);
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

      // Only create the session once the camera works, so failed starts don't
      // leave empty sessions behind.
      await createSession();

      startPositioning();

      logIntervalId = window.setInterval(logPoint, 1000 / DATAPOINTS_PER_SECOND);
    } catch (e) {
      console.error(e);
      hudStatus.textContent = "Error starting eye tracker";
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
    await flushCache();
    endWebgazer();
    hudStatus.textContent = "Submitted";
  };

  window.addEventListener("beforeunload", () => {
    // Best-effort flush of remaining points on tab close.
    if (dataCache.length && sessionId != null && navigator.sendBeacon) {
      navigator.sendBeacon(
        API_BASE + "/api/points",
        new Blob([JSON.stringify({ points: dataCache })], { type: "application/json" })
      );
    }
    endWebgazer();
  });

  acceptBtn.addEventListener("click", () => {
    participantName = participantNameInput.value.trim();
    if (!participantName) {
      participantNameError.classList.add("show");
      participantNameInput.focus();
      return;
    }
    setConsent(true);
    consentBackdrop.classList.remove("show");
    startFlow();
  });

  declineBtn.addEventListener("click", () => {
    setConsent(false);
    consentBackdrop.classList.remove("show");
    hudStatus.textContent = "Consent declined";
  });

  cameraRetryBtn.addEventListener("click", () => window.location.reload());

  participantNameInput.addEventListener("input", () => {
    participantNameError.classList.remove("show");
  });

  // On load: always show the modal, since every session needs a participant
  // name (the computer may be shared, so it is not remembered between visits).
  consentBackdrop.classList.add("show");
  participantNameInput.focus();
})();
