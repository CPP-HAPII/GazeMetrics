/*
 * Shared exam renderer. Call startExam(pages) from the exam HTML file with
 * an array of page objects:
 *   { type: "directions", id, title, body, buttonLabel, audioSrc?, compact?, showPrevious? }
 *     (showPrevious adds a "Previous" button back to the page before it;
 *      directions pages sharing a `group` show a "Page x of n" counter)
 *   { type: "audio",      id, instructions, audioSrc, choices, buttonLabel }
 *     (question audio can be played only once; directions audio is replayable)
 *   { type: "text",       id, lines: [line1, line2?], choices, buttonLabel }
 *   { type: "text",       id, passage, question, choices, buttonLabel }
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

    // Questions are numbered by position, skipping the directions pages.
    const questionPages = pages.filter((p) => p.type !== "directions");

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
      const number = questionPages.indexOf(page) + 1;
      const numberLabel = `<span class="qnum">${number}.</span>`;
      const card = getCard();
      // A clip still playing must not carry over onto the next page.
      if (questionAudio) {
        releaseAudio(questionAudio);
        questionAudio = null;
      }
      card.innerHTML = "";
      card.id = page.id;

      // Tell the capture page (eyetracker.js) which page is now on screen, for
      // per-question timing. Every page renders into this one document, so it
      // can't tell from page loads.
      window.currentExamPage = { id: page.id, type: page.type };
      try { window.parent.onExamPageShown?.(window.currentExamPage); } catch { /* ignore */ }

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
            ${numberLabel}
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
        const prompt = page.lines
          ? page.lines.map((line, i) => `<p class="line${i + 1}">${i === 0 ? numberLabel + " " : ""}${line}</p>`).join("")
          : `<p>${numberLabel} ${page.passage}</p><p class="question">${page.question}</p>`;
        card.innerHTML = `
          <div class="prompt-label">Choose the best answer.</div>
          <div id="${page.id}-prompt" class="dialogue">${prompt}</div>
        `;
        card.appendChild(buildOptions(page.id, page.choices));
      }

      // Corner counter: question number, or the page's position within a
      // multi-page set of directions (pages sharing the same `group`).
      let countText = null;
      if (page.type !== "directions") {
        countText = `Question ${number} of ${questionPages.length}`;
      } else if (page.group) {
        const groupPages = pages.filter((p) => p.group === page.group);
        countText = `Page ${groupPages.indexOf(page) + 1} of ${groupPages.length}`;
      }
      if (countText) {
        const count = document.createElement("div");
        count.className = "page-count";
        count.textContent = countText;
        card.appendChild(count);
      }

      const actions = document.createElement("div");
      actions.className = "actions";
      // Only multi-page directions opt in, so questions can't be revisited.
      if (page.showPrevious && index > 0) {
        const prev = document.createElement("button");
        prev.className = "btn btn-secondary";
        prev.id = `${page.id}-prev-btn`;
        prev.textContent = "Previous";
        prev.addEventListener("click", () => {
          current -= 1;
          renderPage(current);
        });
        actions.appendChild(prev);
      }
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
