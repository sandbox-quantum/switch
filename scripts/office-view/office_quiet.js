// office_quiet.js — run in the office page before its own scripts load, to keep
// the pinned Claude-Office (v1.3.0) quiet for a recording.
//
// Inject it with CDP Page.addScriptToEvaluateOnNewDocument({source}) or
// Playwright's page.add_init_script(path=...), then load the office link.
//
// What it does:
// - Sets the page's own preferences (localStorage, src/settings.ts and
//   src/theme.ts in the office): sound muted, ambient office bed off, no
//   seasonal decorations, fixed daytime lighting, the default theme.
// - Drops the office's random-event timer. The page fires a random office
//   event (pizza, fire drill, power flicker, printer jam, deploy fail, ...)
//   every 60-120 s with no setting to turn it off: App.tsx schedules it as
//   setTimeout(fire, 60000 + Math.random() * 60000) and re-arms it only from
//   inside the callback. That is the only fractional delay in that range, so
//   dropping it once stops the loop and leaves every other timer alone.
(() => {
  const prefs = {
    'agent-office-muted': '1',
    'agent-office-ambience': '0',
    'agent-office-season': 'off',
    'agent-office-daynight': 'day',
    'agent-office-theme': 'default',
  }
  try {
    for (const [key, value] of Object.entries(prefs)) localStorage.setItem(key, value)
  } catch (err) {
    console.warn('[office-view] could not set the quiet preferences:', err)
  }

  const realSetTimeout = window.setTimeout.bind(window)
  window.__officeViewDroppedEvents = 0
  window.setTimeout = function (handler, delay, ...args) {
    if (typeof delay === 'number' && delay >= 60000 && delay < 120000 && !Number.isInteger(delay)) {
      window.__officeViewDroppedEvents += 1
      console.info(`[office-view] dropped the random office event timer (${Math.round(delay)} ms)`)
      return realSetTimeout(() => {}, 0)
    }
    return realSetTimeout(handler, delay, ...args)
  }
})()
