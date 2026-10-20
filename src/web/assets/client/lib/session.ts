export const SESSION_SCRIPT = String.raw`
// Browser session helper for password-protected listeners. The session
// itself is an HttpOnly cookie owned by the server; this module never reads
// or stores a credential. It only routes an expired page back to the
// sign-in page with a same-origin return path.
let redirecting = false;

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
`;
