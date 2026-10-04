// Base URL of the deployed backend. Stays "" wherever main.py serves this
// frontend itself (local dev, or the Render URL), so requests are same-origin;
// set to the Render backend when the frontend is hosted elsewhere (e.g. Vercel).
(function () {
  const BACKEND_URL = "https://gazemetrics.onrender.com";
  const host = window.location.hostname;
  const sameOrigin =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === new URL(BACKEND_URL).hostname;

  window.API_BASE_URL = sameOrigin ? "" : BACKEND_URL;

  // The free Render backend sleeps when idle. Wake it as soon as any page
  // loads so it is ready by the time the user finishes consent/calibration.
  if (!sameOrigin) {
    fetch(BACKEND_URL + "/api/health").catch(() => { /* ignore */ });
  }
})();
