export const SESSION_SCRIPT = String.raw`
// Browser session helpers for password-protected listeners. The session
// itself is an HttpOnly cookie owned by the server; this module never reads
// or stores a credential. It only signs out and routes an expired page back
// to the sign-in page with a same-origin return path.
let redirecting = false;

export function passwordSession() {
  const meta = document.querySelector('meta[name="yui-web-auth"]');
  return Boolean(meta) && meta.content === "password";
}

export function returnTarget() {
  return window.location.pathname + window.location.search;
}

// Called when any API read/write answers 401. Navigates once; the fragment
// survives on the sign-in URL and is restored after a successful sign-in.
export function sessionExpired() {
  if (redirecting) return;
  redirecting = true;
  const query = new URLSearchParams({ reason: "expired" });
  if (returnTarget() !== "/") query.set("next", returnTarget());
  window.location.assign("/login?" + query.toString() + window.location.hash);
}

export async function signOut() {
  const response = await fetch("/auth/logout", {
    method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "content-type": "application/json", accept: "application/json" }, body: "{}"
  });
  if (!response.ok) throw new Error("HTTP " + response.status);
  const body = await response.json();
  const location = body && typeof body.location === "string" && body.location.startsWith("/") && !body.location.startsWith("//")
    ? body.location : "/login";
  redirecting = true;
  window.location.assign(location);
}

// Reveals one sign-out control only when the listener uses password sign-in.
export function bindSignOut(button, t, report) {
  if (!button || !passwordSession()) return;
  button.hidden = false;
  button.addEventListener("click", async function () {
    if (button.disabled) return;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      await signOut();
    } catch {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      report(t("signOut.failed"));
    }
  });
}
`;
