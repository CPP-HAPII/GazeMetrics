/*
 * Shared exam renderer. Call startExam(pages) from the exam HTML file with
 * an array of page objects:
 *   { type: "directions", id, title, body, buttonLabel, audioSrc?, compact? }
 *   { type: "audio",      id, instructions, audioSrc, choices, buttonLabel }
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

  window.startExam = function (pages) {
    let current = 0;

    // Looked up by class, not id: the container's id is overwritten below
    // to the current question's id (for gaze-tracking labels), so an
    // id-based lookup would only work on the very first render.
    function getCard() {
      return document.querySelector(".card");
    }

    function renderPage(index) {
      const page = pages[index];
      const isLast = index === pages.length - 1;
      const card = getCard();
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
            <audio controls src="${page.audioSrc}"></audio>
          </div>
        `;
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

    renderPage(current);
  };
})();
