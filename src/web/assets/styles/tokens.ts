/*
 * DESIGN TOKENS
 * -------------
 * Geometry, type, spacing and motion are theme-independent and live once on
 * :root. A theme block defines colour and effect tokens only, so switching a
 * theme can never move or resize anything.
 *
 * Themes
 *   sumi  (墨) graphite dark, vermilion accent — default dark
 *   washi (和紙) warm paper light, vermilion accent — default light
 *   ai    (藍) deep indigo dark, periwinkle accent
 * "system" is not a token block: client/theme.ts resolves it to sumi or washi
 * from prefers-color-scheme and stamps the resolved name on <html>.
 *
 * To add a theme: add a [data-theme="name"] block defining every colour token
 * below, then register the name in client/theme.ts and the settings menu.
 */
export const TOKEN_STYLES = `
:root{
  --font-sans:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  --font-mono:"JetBrains Mono",ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;
  --fs-2xs:10.5px;--fs-xs:11.5px;--fs-sm:12.5px;--fs-md:13.5px;--fs-lg:15px;--fs-xl:19px;--fs-2xl:24px;
  --sp-1:4px;--sp-2:8px;--sp-3:12px;--sp-4:16px;--sp-5:20px;--sp-6:24px;--sp-8:32px;
  --r-xs:5px;--r-sm:7px;--r-md:10px;--r-lg:14px;--r-pill:999px;
  --sidebar-w:clamp(260px,21vw,312px);--dock-w:440px;--dock-min:320px;--divider-w:9px;
  --center-max:980px;--header-h:56px;
  --t-fast:120ms;--t-med:220ms;--ease:cubic-bezier(.2,.8,.2,1);
}
:root,[data-theme="sumi"]{
  color-scheme:dark;
  --canvas:#0e0f11;--surface:#141518;--surface-2:#191a1e;--surface-3:#202126;--sunken:#0b0c0d;
  --line:rgba(255,255,255,.065);--line-2:rgba(255,255,255,.11);--line-3:rgba(255,255,255,.18);
  --ink:#ececee;--ink-2:#b4b5bb;--ink-3:#85868e;--ink-4:#5c5d64;
  --accent:#ff7a52;--accent-ink:#1a0c06;--accent-soft:rgba(255,122,82,.12);--accent-line:rgba(255,122,82,.38);
  --info:#6cb6ff;--info-soft:rgba(108,182,255,.13);
  --ok:#4fd18b;--ok-soft:rgba(79,209,139,.13);
  --warn:#f5c065;--warn-soft:rgba(245,192,101,.14);
  --bad:#ff6b7a;--bad-soft:rgba(255,107,122,.13);
  --idle:#8e8f97;--idle-soft:rgba(142,143,151,.14);
  --shadow-1:0 1px 0 rgba(255,255,255,.03) inset,0 1px 2px rgba(0,0,0,.35);
  --shadow-2:0 12px 40px rgba(0,0,0,.5),0 2px 8px rgba(0,0,0,.35);
  --focus:0 0 0 2px var(--canvas),0 0 0 4px var(--accent-line);
  --term-bg:#0b0c0d;--term-fg:#e6e6e8;--term-cursor:#ff7a52;--term-sel:#3a2a24;
}
[data-theme="washi"]{
  color-scheme:light;
  --canvas:#f4f2ed;--surface:#fbfaf7;--surface-2:#ffffff;--surface-3:#f1eee7;--sunken:#ebe8e0;
  --line:rgba(40,32,20,.08);--line-2:rgba(40,32,20,.13);--line-3:rgba(40,32,20,.22);
  --ink:#1d1b18;--ink-2:#45413b;--ink-3:#77726a;--ink-4:#a39e95;
  --accent:#d24a26;--accent-ink:#ffffff;--accent-soft:rgba(210,74,38,.09);--accent-line:rgba(210,74,38,.34);
  --info:#1f6fd1;--info-soft:rgba(31,111,209,.09);
  --ok:#17844f;--ok-soft:rgba(23,132,79,.1);
  --warn:#a86500;--warn-soft:rgba(168,101,0,.1);
  --bad:#c72f45;--bad-soft:rgba(199,47,69,.09);
  --idle:#7a756c;--idle-soft:rgba(122,117,108,.11);
  --shadow-1:0 1px 2px rgba(40,32,20,.06);
  --shadow-2:0 16px 40px rgba(40,32,20,.16),0 2px 8px rgba(40,32,20,.08);
  --focus:0 0 0 2px var(--canvas),0 0 0 4px var(--accent-line);
  --term-bg:#1b1a18;--term-fg:#efece6;--term-cursor:#ff8a63;--term-sel:#4a3a32;
}
[data-theme="ai"]{
  color-scheme:dark;
  --canvas:#0a0e1a;--surface:#0f1424;--surface-2:#141a2e;--surface-3:#1a2139;--sunken:#080b15;
  --line:rgba(160,180,255,.08);--line-2:rgba(160,180,255,.13);--line-3:rgba(160,180,255,.22);
  --ink:#e7eaf6;--ink-2:#b0b7d2;--ink-3:#8088a8;--ink-4:#565e7d;
  --accent:#8fa8ff;--accent-ink:#0a0e1a;--accent-soft:rgba(143,168,255,.13);--accent-line:rgba(143,168,255,.4);
  --info:#6fd3ff;--info-soft:rgba(111,211,255,.12);
  --ok:#5ad6a0;--ok-soft:rgba(90,214,160,.12);
  --warn:#f2c46d;--warn-soft:rgba(242,196,109,.13);
  --bad:#ff7d93;--bad-soft:rgba(255,125,147,.13);
  --idle:#8a91ad;--idle-soft:rgba(138,145,173,.14);
  --shadow-1:0 1px 0 rgba(255,255,255,.03) inset,0 1px 2px rgba(0,0,0,.4);
  --shadow-2:0 14px 44px rgba(0,0,0,.55),0 2px 8px rgba(0,0,0,.4);
  --focus:0 0 0 2px var(--canvas),0 0 0 4px var(--accent-line);
  --term-bg:#080b15;--term-fg:#e2e6f5;--term-cursor:#8fa8ff;--term-sel:#26305a;
}
`;
