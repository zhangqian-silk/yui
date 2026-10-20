export const LOGIN_SCRIPT = String.raw`
// Sign-in page controller. Posts the password once per submission as
// same-origin JSON; the server sets an HttpOnly session cookie and returns a
// validated same-origin destination. The password is never written to the
// URL, storage or console, and the field is cleared after a rejection.
import { createI18n } from "/assets/js/lib/i18n.js";

const form = document.querySelector("#login-form");
const password = document.querySelector("#login-password");
const reveal = document.querySelector("#login-reveal");
const submit = document.querySelector("#login-submit");
const submitLabel = document.querySelector("#login-submit-label");
const errorBox = document.querySelector("#login-error");
const notice = document.querySelector("#login-notice");
const transport = document.querySelector("#login-transport");

const i18n = createI18n(document.querySelector("#locale-select"));
const t = i18n.t;
const params = new URLSearchParams(window.location.search);
const next = params.get("next") || "/";
const reason = params.get("reason");
let busy = false;
let lockedUntil = 0;
let lockTimer = null;
let currentError = null;

function isLoopbackHost(host) {
  return host === "localhost" || host === "[::1]" || /^127\./.test(host);
}

function showError(key, values) {
  currentError = { key: key, values: values || {} };
  let text = t(key);
  Object.keys(currentError.values).forEach(function (name) { text = text.split("{" + name + "}").join(String(currentError.values[name])); });
  errorBox.textContent = text;
  errorBox.hidden = false;
  password.setAttribute("aria-invalid", key === "login.error.network" || key === "login.error.origin" ? "false" : "true");
}

function clearError() {
  currentError = null;
  errorBox.hidden = true;
  errorBox.textContent = "";
  password.setAttribute("aria-invalid", "false");
}

function setBusy(value) {
  busy = value;
  form.setAttribute("aria-busy", value ? "true" : "false");
  password.readOnly = value;
  updateSubmit();
}

function updateSubmit() {
  const locked = Date.now() < lockedUntil;
  submit.disabled = busy || locked;
  submitLabel.textContent = t(busy ? "login.submitting" : "login.submit");
}

function renderStatic() {
  document.title = t("login.title");
  if (reason === "expired" || reason === "signed-out") {
    notice.className = "login-notice " + (reason === "expired" ? "tone-warn" : "tone-ok");
    notice.textContent = t(reason === "expired" ? "login.notice.expired" : "login.notice.signedOut");
    notice.hidden = false;
  }
  const revealed = reveal.getAttribute("aria-pressed") === "true";
  reveal.setAttribute("aria-label", t(revealed ? "login.hide" : "login.show"));
  reveal.title = t(revealed ? "login.hide" : "login.show");
  if (currentError) showError(currentError.key, currentError.values);
  updateSubmit();
}

function lockFor(seconds) {
  lockedUntil = Date.now() + seconds * 1000;
  window.clearInterval(lockTimer);
  const tick = function () {
    const remaining = Math.ceil((lockedUntil - Date.now()) / 1000);
    if (remaining <= 0) {
      window.clearInterval(lockTimer);
      lockTimer = null;
      clearError();
      updateSubmit();
      return;
    }
    showError("login.error.throttled", { seconds: remaining });
    updateSubmit();
  };
  tick();
  lockTimer = window.setInterval(tick, 1000);
}

reveal.addEventListener("click", function () {
  const revealed = reveal.getAttribute("aria-pressed") !== "true";
  reveal.setAttribute("aria-pressed", revealed ? "true" : "false");
  password.type = revealed ? "text" : "password";
  renderStatic();
  password.focus();
});

password.addEventListener("input", function () {
  if (currentError && currentError.key !== "login.error.throttled") clearError();
});

form.addEventListener("submit", async function (event) {
  event.preventDefault();
  if (busy || Date.now() < lockedUntil) return;
  if (!password.value) {
    showError("login.error.empty");
    password.focus();
    return;
  }
  clearError();
  setBusy(true);
  let response;
  let body = null;
  try {
    response = await fetch("/auth/login", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ password: password.value, next: next })
    });
    try { body = await response.json(); } catch {}
  } catch {
    setBusy(false);
    showError("login.error.network");
    password.focus();
    return;
  }
  if (response.ok && body && typeof body.location === "string" && body.location.startsWith("/") && !body.location.startsWith("//")) {
    // Keep the busy state while the browser navigates to the destination.
    window.location.replace(body.location + window.location.hash);
    return;
  }
  setBusy(false);
  if (response.status === 429) {
    lockFor(Math.max(1, Number(body && body.retryAfterSeconds) || Number(response.headers.get("retry-after")) || 30));
  } else if (response.status === 401) {
    password.value = "";
    showError("login.error.invalid");
  } else if (response.status === 403) {
    showError("login.error.origin");
  } else if (response.status === 404 && body && body.code === "password-not-configured") {
    window.location.replace("/");
    return;
  } else {
    showError("login.error.network");
  }
  password.focus();
});

i18n.subscribe(renderStatic);
transport.hidden = window.location.protocol !== "http:" || isLoopbackHost(window.location.hostname);
renderStatic();
password.focus();
`;
