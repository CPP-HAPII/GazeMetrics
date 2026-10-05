/*
 * Shared exam renderer. Call startExam(pages) from the exam HTML file with
 * an array of page objects:
 *   { type: "directions", id, title, body, buttonLabel, audioSrc?, compact? }
 *   { type: "audio",      id, instructions, audioSrc, choices, buttonLabel }
 *     (question audio can be played only once; directions audio is replayable)
 *   { type: "text",       id, lines: [line1, line2], choices, buttonLabel }
 * The last entry always renders a "Submit" button that ends the exam.
 */
(function () {
  "use strict";

  const LETTERS = ["a", "b", "c", "d"];

  function buildOptions(pageId, choices) {
    const wrap = document.createElement("div");
    wrap.className = "options";
    choices.forEach((text, i) => {
      const letter = LETTERS[i];
      const opt = document.createElement("div");
      opt.className = "option";
      opt.id = `${pageId}-${letter}`;
      opt.innerHTML = `
        <input type="radio" name="${pageId}" id="${pageId}-${letter}-input" value="${letter}">
        <label for="${pageId}-${letter}-input">${text}</label>
      `;
      wrap.appendChild(opt);
    });
    return wrap;
  }

  // Drops the clip so it can't be resumed or restarted (e.g. by a keyboard
  // media key) once it has ended or its page is gone.
  function releaseAudio(audio) {
    audio.removeAttribute("src");
    audio.load();
  }

  // Question audio may be heard only once: a plain button instead of the
  // native player (whose seek bar would allow re-listening), locked for good
  // as soon as playback starts. onStarted runs once the clip is really
  // playing; alreadyPlayed restores the locked state after a reload.
  function setupPlayOnce(btn, src, alreadyPlayed, onStarted) {
    if (alreadyPlayed) {
      btn.disabled = true;
      btn.textContent = "Audio played";
      return null;
    }
    const audio = new Audio(src);
    btn.addEventListener("click", () => {
      btn.disabled = true;
      btn.textContent = "Playing…";
      audio.play().then(onStarted, () => {
        // Never started (e.g. the file failed to load), so the one listen
        // isn't used up.
        btn.disabled = false;
        btn.textContent = "Play audio";
      });
    });
    audio.addEventListener("ended", () => {
      btn.textContent = "Audio played";
      releaseAudio(audio);
    });
    return audio;
  }

  window.startExam = function (pages) {
    // Progress is kept in sessionStorage so a reload resumes on the same page
    // (with a started question clip still locked) instead of restarting the
    // exam. It lasts as long as the tab does.
    const PROGRESS_KEY = "examProgress:" + location.pathname;

    function loadProgress() {
      try {
        const saved = JSON.parse(sessionStorage.getItem(PROGRESS_KEY));
        if (saved && Number.isInteger(saved.index) && saved.index >= 0 && saved.index < pages.length) {
          return saved;
        }
      } catch { /* ignore */ }
      return { index: 0, audioPlayed: false };
    }

    function saveProgress(index, audioPlayed) {
      try {
        sessionStorage.setItem(PROGRESS_KEY, JSON.stringify({ index, audioPlayed }));
      } catch { /* ignore */ }
    }

    const progress = loadProgress();
    let current = progress.index;
    let questionAudio = null;

    // Looked up by class, not id: the container's id is overwritten below
    // to the current question's id (for gaze-tracking labels), so an
    // id-based lookup would only work on the very first render.
    function getCard() {
      return document.querySelector(".card");
    }

    function renderPage(index, audioPlayed = false) {
      saveProgress(index, audioPlayed);
      const page = pages[index];
      const isLast = index === pages.length - 1;
      const card = getCard();
      // A clip still playing must not carry over onto the next page.
      if (questionAudio) {
        releaseAudio(questionAudio);
        questionAudio = null;
      }
      card.innerHTML = "";
      card.id = page.id;

      if (page.type === "directions") {
        const audio = page.audioSrc ? `
          <div id="${page.id}-media" class="audio-block">
            <audio controls src="${page.audioSrc}"></audio>
          </div>
        ` : "";
        card.innerHTML = `
          <div class="directions-title">${page.title}</div>
          ${audio}
          <div class="directions-body${page.compact ? " compact" : ""}">${page.body}</div>
        `;
      } else if (page.type === "audio") {
        card.innerHTML = `
          <div class="prompt-label">${page.instructions}</div>
          <div id="${page.id}-media" class="audio-block">
            <button type="button" class="btn play-once">Play audio</button>
          </div>
        `;
        questionAudio = setupPlayOnce(
          card.querySelector(".play-once"),
          page.audioSrc,
          audioPlayed,
          () => saveProgress(index, true)
        );
        card.appendChild(buildOptions(page.id, page.choices));
      } else if (page.type === "text") {
        card.innerHTML = `
          <div class="prompt-label">Choose the best answer.</div>
          <div id="${page.id}-prompt" class="dialogue">
            <p class="line1">${page.lines[0]}</p>
            <p class="line2">${page.lines[1]}</p>
          </div>
        `;
        card.appendChild(buildOptions(page.id, page.choices));
      }

      const actions = document.createElement("div");
      actions.className = "actions";
      const btn = document.createElement("button");
      btn.className = "btn";
      btn.id = `${page.id}-btn`;
      btn.textContent = isLast ? "Submit" : (page.buttonLabel || "Next");
      btn.addEventListener("click", () => {
        if (isLast) {
          submitExam(btn);
        } else {
          current += 1;
          renderPage(current);
        }
      });
      actions.appendChild(btn);
      card.appendChild(actions);
    }

    async function submitExam(btn) {
      btn.disabled = true;
      try { sessionStorage.removeItem(PROGRESS_KEY); } catch { /* ignore */ }
      getCard().style.display = "none";
      document.getElementById("submitted").classList.add("show");
      document.getElementById("recordingOverlay").classList.add("show");
      try {
        await window.parent.finishExam();
      } catch { /* ignore */ }
    }

    document.getElementById("popupOkBtn").addEventListener("click", () => {
      document.getElementById("recordingOverlay").classList.remove("show");
    });

    // Called by the capture page (eyetracker.js) when a different participant
    // takes over this tab, so they don't resume someone else's exam.
    window.resetExam = function () {
      current = 0;
      renderPage(current);
    };

    renderPage(current, progress.audioPlayed);
  };
})();
