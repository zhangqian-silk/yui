// A small stroke icon set (24×24 grid, round caps). Shared by the static shell
// markup and the client DOM builder so both draw from one geometry source.
// Each entry is a list of SVG path "d" strings.
export const ICON_PATHS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  refresh: ["M20 11a8 8 0 0 0-14.3-4.9L4 8", "M4 4v4h4", "M4 13a8 8 0 0 0 14.3 4.9L20 16", "M20 20v-4h-4"],
  search: ["M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z", "M20 20l-4-4"],
  terminal: ["M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z", "M7 10l3 2-3 2", "M12 15h5"],
  send: ["M4 12l16-8-6 16-2.5-6.5z", "M11.5 13.5L20 4"],
  swap: ["M7 7h13", "M16 3l4 4-4 4", "M17 17H4", "M8 13l-4 4 4 4"],
  close: ["M6 6l12 12", "M18 6L6 18"],
  back: ["M19 12H5", "M11 6l-6 6 6 6"],
  dock: ["M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z", "M14 5v14", "M17 9h1", "M17 12h1"],
  settings: ["M4 7h10", "M18 7h2", "M16 5v4", "M4 17h4", "M12 17h8", "M10 15v4"],
  chat: ["M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-4 3v-3H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"],
  broadcast: ["M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z", "M8.5 8.5a5 5 0 0 0 0 7", "M15.5 8.5a5 5 0 0 1 0 7", "M5.6 5.6a9 9 0 0 0 0 12.8", "M18.4 5.6a9 9 0 0 1 0 12.8"],
  chevron: ["M9 6l6 6-6 6"],
  down: ["M6 9l6 6 6-6"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  alert: ["M12 4l9 16H3z", "M12 10v4", "M12 17v.5"],
  clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 7v5l3 2"],
  file: ["M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z", "M14 3v5h5"],
  copy: ["M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z", "M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"],
  layers: ["M12 3l9 5-9 5-9-5z", "M3 13l9 5 9-5"],
  pulse: ["M3 12h4l3-7 4 14 3-7h4"],
  history: ["M3 12a9 9 0 1 0 3-6.7", "M3 4v4h4", "M12 8v4l3 2"],
  dots: ["M5 12h.01", "M12 12h.01", "M19 12h.01"],
  inbox: ["M4 13l2.5-8h11L20 13", "M4 13v6h16v-6", "M4 13h5l1 2h4l1-2h5"],
  user: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M4 20a8 8 0 0 1 16 0"],
  eye: ["M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"],
  plus: ["M12 5v14", "M5 12h14"],
  target: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M12 12h.01"],
  flag: ["M5 21V4", "M5 4h11l-2 4 2 4H5"],
  sparkle: ["M12 3v4", "M12 17v4", "M3 12h4", "M17 12h4", "M6 6l2.5 2.5", "M15.5 15.5L18 18", "M18 6l-2.5 2.5", "M8.5 15.5L6 18"]
});

export function iconSvg(name: string, className = "icon"): string {
  const paths = ICON_PATHS[name] ?? [];
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">`
    + paths.map((d) => `<path d="${d}"/>`).join("") + "</svg>";
}
