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
 *   { type: "text",       id, question, choices, buttonLabel }   (question only)
 *   { type: "reading",    id, text }
 *     (a reading passage with no buttons: the space bar moves on)
 * The last entry always renders a "Submit" button that ends the exam.
 *
 * ?start=<page id> in this page's URL, or in the capture page's URL around
 * it, starts the exam at that page instead of the first one (for testing,
 * e.g. ?start=reading-directions).
 */
(function () {
  "use strict";

  const LETTERS = ["a", "b", "c", "d"];

  function buildOptions(pageId, choices) {
    const wrap = document.createElement("div");
    wrap.className = "options";
    wrap.id = `${pageId}-options`;
    choices.forEach((text, i) => {
      const letter = LETTERS[i];
      const opt = document.createElement("div");
      opt.className = "option";
      opt.id = `${pageId}-${letter}`;
      opt.innerHTML = `
        <input type="radio" name="${pageId}" id="${pageId}-${letter}-input" value="${letter}">
        <label id="${pageId}-${letter}-text" for="${pageId}-${letter}-input">${text}</label>
      `;
      // Words of answer a are named q95-a-l1-w1, q95-a-l1-w2, ...
      wrapWords(opt.querySelector("label"), `${pageId}-${letter}`);
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

  // Reading passages wrap to about this many lines (Ben's spec: 10 ± 2).
  const READING_TARGET_LINES = 10;

  // Size a passage's width (in ch, one monospace character each) so it wraps
  // to READING_TARGET_LINES lines: the narrowest width that still fits in that
  // many lines. On a screen too narrow for that, it takes the full width and
  // wraps to a few more lines instead.
  function fitReadingWidth(el) {
    const lineHeight = parseFloat(getComputedStyle(el).fontSize) * 1.5;
    const lines = () => Math.round(el.getBoundingClientRect().height / lineHeight);
    const parentStyle = getComputedStyle(el.parentElement);
    const maxPx = el.parentElement.clientWidth
      - parseFloat(parentStyle.paddingLeft) - parseFloat(parentStyle.paddingRight);
    let width = Math.ceil(el.textContent.length / READING_TARGET_LINES);
    el.style.width = width + "ch";
    // max-width: 100% (exam.css) caps the width at maxPx, which ends this loop.
    while (lines() > READING_TARGET_LINES && el.getBoundingClientRect().width < maxPx - 1 && width < 400) {
      width += 1;
      el.style.width = width + "ch";
    }
    while (width > 20) {
      el.style.width = (width - 1) + "ch";
      if (lines() > READING_TARGET_LINES) {
        el.style.width = width + "ch";
        break;
      }
      width -= 1;
    }
  }

  // Gaze is labelled with the id of the element it lands on, so the finer the
  // ids, the more detailed the data. Every piece of text on a page is split
  // into one span per word, and each word gets an id saying where it is, e.g.
  // passage-3-l2-w17 (passage 3, line 2, word 17) or q95-a-l1-w2 (question
  // 95, answer a, word 2). The part before -l is the id of the block it
  // belongs to, so results can be grouped by word, line or block later.

  // Wrap every word inside `el` in a span.word and mark `el` as a word group
  // whose words are named `${base}-l<line>-w<n>` (by labelWords). Text in
  // buttons, audio players and the question number is left alone.
  function wrapWords(el, base) {
    if (!el) return;
    el.dataset.wordBase = base;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.parentElement.closest("button, audio, .qnum") || !node.textContent.trim()
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    let index = 0;
    textNodes.forEach((node) => {
      const frag = document.createDocumentFragment();
      node.textContent.split(/(\s+)/).forEach((part) => {
        if (!part) return;
        if (!part.trim()) {
          frag.appendChild(document.createTextNode(part));
          return;
        }
        const span = document.createElement("span");
        span.className = "word";
        span.dataset.index = String(++index);
        span.textContent = part;
        frag.appendChild(span);
      });
      node.replaceWith(frag);
    });
  }

  // Name each word of a group by its line and position. Lines depend on the
  // screen size, so this runs after layout (and again on resize).
  function labelWords(groupEl, base) {
    let line = 0;
    let lastTop = null;
    groupEl.querySelectorAll(".word").forEach((span) => {
      const top = span.getBoundingClientRect().top;
      if (lastTop === null || Math.abs(top - lastTop) > 2) {
        line += 1;
        lastTop = top;
      }
      span.id = `${base}-l${line}-w${span.dataset.index}`;
    });
  }

  function labelAllWords(root) {
    root.querySelectorAll("[data-word-base]").forEach((g) => labelWords(g, g.dataset.wordBase));
  }

  // The page id given as ?start=<id>, here or in the capture page's URL.
  function requestedStartId() {
    let id = new URLSearchParams(location.search).get("start");
    if (!id) {
      try { id = new URLSearchParams(window.parent.location.search).get("start"); } catch { /* ignore */ }
    }
    return id;
  }

  window.startExam = function (pages) {
    const requestedIndex = pages.findIndex((p) => p.id === requestedStartId());
    const startIndex = requestedIndex >= 0 ? requestedIndex : 0;

    // Progress is kept in sessionStorage so a reload resumes on the same page
    // (with a started question clip still locked) instead of restarting the
    // exam. It lasts as long as the tab does. An explicit ?start= wins.
    const PROGRESS_KEY = "examProgress:" + location.pathname;

    function loadProgress() {
      if (requestedIndex >= 0) return { index: requestedIndex, audioPlayed: false };
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

    // Questions are numbered by position, skipping directions and reading
    // passages.
    const questionPages = pages.filter((p) => p.type !== "directions" && p.type !== "reading");

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
      const numberLabel = `<span class="qnum" id="${page.id}-number">${number}.</span>`;
      const card = getCard();
      // A clip still playing must not carry over onto the next page.
      if (questionAudio) {
        releaseAudio(questionAudio);
        questionAudio = null;
      }
      card.innerHTML = "";
      card.id = page.id;
      card.classList.toggle("reading-card", page.type === "reading");

      // Tell the capture page (eyetracker.js) which page is now on screen, for
      // per-question timing. Every page renders into this one document, so it
      // can't tell from page loads.
      window.currentExamPage = { id: page.id, type: page.type };
      try { window.parent.onExamPageShown?.(window.currentExamPage); } catch { /* ignore */ }

      if (page.type === "reading") {
        // Just the passage: no counter or buttons; the space bar moves on.
        const text = document.createElement("div");
        text.id = `${page.id}-text`;
        text.className = "reading-text";
        text.textContent = page.text;
        wrapWords(text, page.id);
        card.appendChild(text);
        fitReadingWidth(text);
        labelAllWords(card);
        // Make sure key presses reach this page, not the capture page around it.
        window.focus();
        return;
      }

      if (page.type === "directions") {
        const audio = page.audioSrc ? `
          <div id="${page.id}-media" class="audio-block">
            <audio controls src="${page.audioSrc}"></audio>
          </div>
        ` : "";
        card.innerHTML = `
          <div id="${page.id}-title" class="directions-title">${page.title}</div>
          ${audio}
          <div id="${page.id}-body" class="directions-body${page.compact ? " compact" : ""}">${page.body}</div>
        `;
        card.querySelectorAll(".directions-body .example").forEach((example, i) => {
          if (!example.id) example.id = `${page.id}-example${i + 1}`;
        });
        wrapWords(card.querySelector(".directions-title"), `${page.id}-title`);
        wrapWords(card.querySelector(".directions-body"), `${page.id}-body`);
      } else if (page.type === "audio") {
        card.innerHTML = `
          <div id="${page.id}-instructions" class="prompt-label">${page.instructions}</div>
          <div id="${page.id}-media" class="audio-block">
            ${numberLabel}
            <button type="button" id="${page.id}-play" class="btn play-once">Play audio</button>
          </div>
        `;
        wrapWords(card.querySelector(".prompt-label"), `${page.id}-instructions`);
        questionAudio = setupPlayOnce(
          card.querySelector(".play-once"),
          page.audioSrc,
          audioPlayed,
          () => saveProgress(index, true)
        );
        card.appendChild(buildOptions(page.id, page.choices));
      } else if (page.type === "text") {
        // Each part of the prompt gets its own id (line1/line2, passage,
        // question) so the gaze data can tell them apart.
        const prompt = page.lines
          ? page.lines.map((line, i) => `<p id="${page.id}-line${i + 1}" class="line${i + 1}">${i === 0 ? numberLabel + " " : ""}${line}</p>`).join("")
          : page.passage
            ? `<p id="${page.id}-passage">${numberLabel} ${page.passage}</p><p id="${page.id}-question" class="question">${page.question}</p>`
            : `<p id="${page.id}-question">${numberLabel} ${page.question}</p>`;
        card.innerHTML = `
          <div id="${page.id}-instructions" class="prompt-label">Choose the best answer.</div>
          <div id="${page.id}-prompt" class="dialogue">${prompt}</div>
        `;
        wrapWords(card.querySelector(".prompt-label"), `${page.id}-instructions`);
        card.querySelectorAll(".dialogue p").forEach((p) => wrapWords(p, p.id));
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
        count.id = `${page.id}-counter`;
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

      // Lines only exist once everything is laid out, so words are named last.
      labelAllWords(card);
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

    // Space bar on a reading passage moves on to its first question. Also
    // called by the capture page when the key press lands there instead.
    window.advanceReading = function () {
      if (pages[current].type !== "reading" || current >= pages.length - 1) return;
      current += 1;
      renderPage(current);
    };
    document.addEventListener("keydown", (e) => {
      if ((e.code !== "Space" && e.key !== " ") || pages[current].type !== "reading") return;
      e.preventDefault();
      if (!e.repeat) window.advanceReading();
    });

    // Where lines break depends on the window's size, so on resize refit a
    // reading passage's width and rename every word by its new line.
    window.addEventListener("resize", () => {
      const text = document.querySelector(".reading-text");
      if (text) fitReadingWidth(text);
      labelAllWords(getCard());
    });

    // Called by the capture page (eyetracker.js) when a different participant
    // takes over this tab, so they don't resume someone else's exam.
    window.resetExam = function () {
      current = startIndex;
      renderPage(current);
    };

    renderPage(current, progress.audioPlayed);
  };
})();
