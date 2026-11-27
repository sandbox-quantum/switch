// Runs before first paint, so the window opens in the right theme. A file of
// its own rather than an inline script: the Content-Security-Policy refuses
// inline script.
(function () {
  try {
    var raw = localStorage.getItem('switchdash-theme');
    var pref = raw ? JSON.parse(raw) : null;
    var effective =
      pref === 'emlight' || pref === 'emdark'
        ? pref
        : window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'emdark'
          : 'emlight';
    document.documentElement.classList.add(effective);
  } catch {}
  try {
    // Paired with the `vibrancy` branch in main/app/window.ts: only
    // macOS gets a translucent window, so only there may the renderer
    // leave the material see-through. Anywhere else the same colour has
    // to be opaque, or the window shows the desktop through an effect
    // the compositor never applied.
    if (navigator.userAgent.indexOf('Macintosh') !== -1) {
      document.documentElement.classList.add('has-vibrancy');
    }
  } catch {}
})();
