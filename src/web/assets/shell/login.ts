import { DEFAULT_DARK_THEME } from "../shared/themes.js";
import { BRAND_ICONS, brandGlyphSvg } from "../shared/brand.js";
import { iconSvg } from "../shared/icons.js";

// The only document served without a session. It carries no page token and
// no Task data; the client module posts the password as same-origin JSON and
// the server answers with a session cookie. CSP form-action 'none' means the
// form can never submit natively (so a password cannot end up in a URL).
const SHEETS = ["fonts", "tokens", "base", "motion", "ui/controls", "ui/forms", "views/login"];

export const LOGIN_HTML = `<!doctype html>
<html lang="en" data-theme="${DEFAULT_DARK_THEME.id}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="dark light">
  <link rel="icon" type="image/svg+xml" href="${BRAND_ICONS[DEFAULT_DARK_THEME.id]}">
  <script src="/assets/theme.js"></script>
  <title>Sign in · Yui</title>
  <link rel="preload" href="/assets/fonts/inter-500.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/assets/fonts/inter-600.woff2" as="font" type="font/woff2" crossorigin>
${SHEETS.map(name => `  <link rel="stylesheet" href="/assets/css/${name}.css">`).join("\n")}
</head>
<body class="login-body">
  <main class="login-shell">
    <section class="login-card" aria-labelledby="login-title">
      <div class="login-top">
        <div class="login-brand">
          <span class="brand-mark" aria-hidden="true">${brandGlyphSvg()}</span>
          <span class="brand-name">Yui</span>
        </div>
        <label class="login-locale"><span class="sr-only" data-i18n="settings.language">Language</span><select id="locale-select"><option value="en">English</option><option value="zh-CN">简体中文</option></select></label>
      </div>
      <header class="login-heading">
        <h1 id="login-title" data-i18n="login.heading">Sign in to Yui</h1>
        <p id="login-subtitle" class="login-sub" data-i18n="login.subtitle">Enter the Web access password from this listener's private credential file.</p>
      </header>
      <p id="login-notice" class="login-notice" role="status" hidden></p>
      <form id="login-form" class="login-form" method="post" novalidate aria-describedby="login-subtitle">
        <input class="sr-only" type="text" name="username" value="yui" autocomplete="username" tabindex="-1" aria-hidden="true" readonly>
        <div class="login-field">
          <label class="login-label" for="login-password" data-i18n="login.password">Password</label>
          <div class="login-password">
            <input id="login-password" name="password" type="password" autocomplete="current-password" required maxlength="256" spellcheck="false" autocapitalize="off" autocorrect="off" aria-describedby="login-error" aria-invalid="false" autofocus>
            <button id="login-reveal" class="icon-btn login-reveal" type="button" aria-controls="login-password" aria-pressed="false" aria-label="Show password" data-i18n-aria-label="login.show" title="Show password" data-i18n-title="login.show">${iconSvg("eye", "icon icon-show")}${iconSvg("eyeOff", "icon icon-hide")}</button>
          </div>
          <p id="login-error" class="login-error" role="alert" hidden></p>
        </div>
        <button id="login-submit" class="btn btn-primary login-submit" type="submit" disabled>
          <span class="login-spinner" aria-hidden="true"></span><span id="login-submit-label" data-i18n="login.submit">Sign in</span>
        </button>
      </form>
      <p id="login-transport" class="login-transport" hidden>${iconSvg("alert")}<span data-i18n="login.httpWarning">This connection uses plain HTTP and is not encrypted. Sign in only on a trusted network.</span></p>
      <noscript><p class="login-error" data-i18n="login.noscript">JavaScript is required to sign in.</p></noscript>
    </section>
  </main>
  <script type="module" src="/assets/js/app/login.js"></script>
</body>
</html>`;
