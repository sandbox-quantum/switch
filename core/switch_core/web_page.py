"""The Switch-branded page shell for browser pages served while a user
connects a service: OAuth results, install confirmations and app handoffs.

Self-contained by design. Every page here is served under a CSP that allows
inline styles and nothing else external, so the stylesheet, logo and icons are
all inline and the page renders with the network off.
"""

from __future__ import annotations

from html import escape
from typing import Literal

PageKind = Literal["success", "error", "info"]

LOGO_SVG = (
    '<svg class="logo" viewBox="0 0 102 102" fill="currentColor" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">'
    '<path d="M24.5117 65.6279C26.997 65.6279 29.0117 67.6426 29.0117 70.1279V77.1279C29.0117 79.6132 26.997 81.6279 24.5117 81.6279C22.0264 81.6279 20.0117 79.6132 20.0117 77.1279V70.1279C20.0117 67.6426 22.0264 65.6279 24.5117 65.6279Z"/>'
    '<path d="M42.5117 65.6279C44.997 65.6279 47.0117 67.6426 47.0117 70.1279V77.1279C47.0117 79.6132 44.997 81.6279 42.5117 81.6279C40.0264 81.6279 38.0117 79.6132 38.0117 77.1279V70.1279C38.0117 67.6426 40.0264 65.6279 42.5117 65.6279Z"/>'
    '<path d="M59.3174 20.1826C61.8027 20.1826 63.8174 22.1973 63.8174 24.6826V31.6826C63.8174 34.1679 61.8027 36.1826 59.3174 36.1826C56.8321 36.1826 54.8174 34.1679 54.8174 31.6826V24.6826C54.8174 22.1973 56.8321 20.1826 59.3174 20.1826Z"/>'
    '<path d="M77.3174 20.1826C79.8027 20.1826 81.8174 22.1973 81.8174 24.6826V31.6826C81.8174 34.1679 79.8027 36.1826 77.3174 36.1826C74.8321 36.1826 72.8174 34.1679 72.8174 31.6826V24.6826C72.8174 22.1973 74.8321 20.1826 77.3174 20.1826Z"/>'
    '<path fill-rule="evenodd" clip-rule="evenodd" d="M89.8232 0C96.4507 0 101.823 5.37258 101.823 12V74.2256C101.823 77.4082 100.559 80.4605 98.3086 82.7109L82.7109 98.3086C80.4605 100.559 77.4082 101.823 74.2256 101.823H12C5.37259 101.823 0 96.4507 0 89.8232V27.5977C0 24.4151 1.26425 21.3627 3.51465 19.1123L19.1123 3.51465C21.3627 1.26425 24.4151 0 27.5977 0H89.8232ZM16 56.4121C13.2386 56.4121 11 58.6507 11 61.4121V84.8232C11 88.1369 13.6863 90.8232 17 90.8232H69.6689C72.8515 90.8232 75.9039 89.559 78.1543 87.3086L87.3086 78.1543C89.559 75.9039 90.8232 72.8515 90.8232 69.6689V61.4121C90.8232 58.6507 88.5847 56.4121 85.8232 56.4121H16ZM32.1543 11C28.9717 11 25.9194 12.2642 23.6689 14.5146L14.5146 23.6689C12.2643 25.9194 11 28.9717 11 32.1543V40.4121C11 43.1735 13.2386 45.4121 16 45.4121H85.8232C88.5847 45.4121 90.8232 43.1735 90.8232 40.4121V17C90.8232 13.6863 88.1369 11 84.8232 11H32.1543Z"/>'
    "</svg>"
)

_ICON_PATHS: dict[PageKind, str] = {
    "success": '<path d="M5.5 12.5l4.5 4.5 8.5-10"/>',
    "error": '<path d="M12 5.5v8"/><circle cx="12" cy="18" r="1.4"/>',
    "info": '<circle cx="12" cy="6" r="1.4"/><path d="M12 10.5v8"/>',
}

_STYLE = """
:root {
  color-scheme: light dark;
  --bg: #f7f6f2;
  --surface: #ffffff;
  --fg: color(display-p3 0.125 0.125 0.125);
  --muted: color(display-p3 0.392 0.392 0.392);
  --hair: rgb(0 0 0 / 0.1);
  --hair-soft: rgb(0 0 0 / 0.06);
  --well: color(display-p3 0.975 0.975 0.975);
  --shadow: 0 1px 2px rgb(0 0 0 / 0.04), 0 8px 24px rgb(0 0 0 / 0.06);
  --primary-bg: color(display-p3 0.142 0.229 0.194);
  --primary-bg-hover: color(display-p3 0.15 0.5 0.37);
  --primary-fg: color(display-p3 0.962 0.983 0.969);
  --primary-border: transparent;
  --secondary-bg: #ffffff;
  --secondary-bg-hover: #f0f0f0;
  --secondary-border: color(display-p3 0.849 0.849 0.849);
  --link: color(display-p3 0.15 0.5 0.37);
  --success-bg: color(display-p3 0.912 0.965 0.932);
  --success-fg: color(display-p3 0.15 0.5 0.37);
  --error-bg: color(display-p3 0.995 0.931 0.931);
  --error-fg: color(display-p3 0.744 0.234 0.222);
  --info-bg: color(display-p3 0.939 0.939 0.939);
  --info-fg: color(display-p3 0.142 0.229 0.194);
  --ring: color(display-p3 0.319 0.63 0.521);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0c0c0c;
    --surface: #161616;
    --fg: color(display-p3 0.933 0.933 0.933);
    --muted: color(display-p3 0.706 0.706 0.706);
    --hair: rgb(255 255 255 / 0.1);
    --hair-soft: rgb(255 255 255 / 0.06);
    --well: color(display-p3 0.098 0.098 0.098);
    --shadow: 0 1px 2px rgb(0 0 0 / 0.4), 0 12px 32px rgb(0 0 0 / 0.4);
    --primary-bg: color(display-p3 0.102 0.228 0.177);
    --primary-bg-hover: color(display-p3 0.133 0.279 0.221);
    --primary-fg: color(display-p3 0.734 0.934 0.838);
    --primary-border: color(display-p3 0.219 0.402 0.335);
    --secondary-bg: #222222;
    --secondary-bg-hover: #2a2a2a;
    --secondary-border: color(display-p3 0.228 0.228 0.228);
    --link: color(display-p3 0.4 0.835 0.656);
    --success-bg: color(display-p3 0.091 0.176 0.138);
    --success-fg: color(display-p3 0.4 0.835 0.656);
    --error-bg: color(display-p3 0.2 0.09 0.09);
    --error-fg: color(display-p3 1 0.57 0.55);
    --info-bg: color(display-p3 0.135 0.135 0.135);
    --info-fg: color(display-p3 0.734 0.934 0.838);
  }
}
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; }
body {
  min-height: 100vh;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 2.5rem 1.25rem 10vh;
  background: var(--bg); color: var(--fg);
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu,
    Cantarell, 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;
  -webkit-font-smoothing: antialiased;
}
.brand {
  display: flex; align-items: center; gap: 0.6rem;
  margin-bottom: 1.5rem; font-size: 1.25rem; font-weight: 600; letter-spacing: -0.01em;
}
.brand .logo { width: 32px; height: 32px; }
.card {
  width: 100%; max-width: 30rem;
  background: var(--surface); border: 1px solid var(--hair); border-radius: 14px;
  box-shadow: var(--shadow);
  padding: 2.25rem 2rem 2rem; text-align: center;
}
.status {
  width: 56px; height: 56px; margin: 0 auto 1.25rem; border-radius: 50%;
  display: grid; place-items: center;
}
.status svg { width: 28px; height: 28px; fill: none; stroke: currentColor;
  stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
.status circle { fill: currentColor; stroke: none; }
.status.success { background: var(--success-bg); color: var(--success-fg); }
.status.error { background: var(--error-bg); color: var(--error-fg); }
.status.info { background: var(--info-bg); color: var(--info-fg); }
h1 { margin: 0 0 0.5rem; font-size: 1.3rem; font-weight: 600; line-height: 1.3;
  letter-spacing: -0.015em; text-wrap: balance; }
.body { color: var(--muted); overflow-wrap: anywhere; }
.body p { margin: 0 0 0.75rem; }
.body p:last-child { margin-bottom: 0; }
.body strong { color: var(--fg); font-weight: 600; }
.body .note { font-size: 0.85rem; margin-top: 1.25rem; }
dl {
  margin: 1.5rem 0 0; padding: 0.25rem 1rem; text-align: left;
  background: var(--well); border: 1px solid var(--hair-soft); border-radius: 10px;
}
dl div { display: flex; gap: 1rem; justify-content: space-between; padding: 0.65rem 0; }
dl div + div { border-top: 1px solid var(--hair-soft); }
dt { color: var(--muted); flex-shrink: 0; }
dd { margin: 0; color: var(--fg); font-weight: 500; text-align: right; overflow-wrap: anywhere; }
form { margin: 1.5rem 0 0; }
.actions { display: flex; gap: 0.75rem; margin-top: 1.5rem; }
form .actions { margin-top: 0; }
.pulse { animation: pulse 2s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
button, .button {
  flex: 1; display: inline-flex; align-items: center; justify-content: center;
  min-height: 2.5rem; padding: 0.55rem 1.1rem; border-radius: 8px;
  font: inherit; font-weight: 500; text-decoration: none; cursor: pointer;
  background: var(--primary-bg); color: var(--primary-fg);
  border: 1px solid var(--primary-border);
  transition: background-color 120ms ease;
}
button:hover, .button:hover { background: var(--primary-bg-hover); }
button.secondary, .button.secondary {
  background: var(--secondary-bg); color: var(--fg); border-color: var(--secondary-border);
}
button.secondary:hover, .button.secondary:hover { background: var(--secondary-bg-hover); }
button:focus-visible, .button:focus-visible, a:focus-visible {
  outline: 2px solid var(--ring); outline-offset: 2px;
}
form > button { width: 100%; }
a { color: var(--link); text-underline-offset: 2px; }
"""


def status_icon(kind: PageKind) -> str:
    return (
        f'<div class="status {kind}"><svg viewBox="0 0 24 24" aria-hidden="true">'
        f"{_ICON_PATHS[kind]}</svg></div>"
    )


def render_page(*, title: str, icon: str, body: str, script: str = "") -> str:
    """A complete page: the Switch header over a card holding `icon`, `title`
    and `body`.

    `title` is plain text and escaped here. `icon`, `body` and `script` are
    markup, inserted as given, so the caller escapes every value it puts in
    them.
    """
    heading = escape(title)
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>{heading}</title><style>{_STYLE}</style></head><body>"
        f'<header class="brand">{LOGO_SVG}<span>Switch</span></header>'
        f'<main class="card">{icon}<h1 id="title">{heading}</h1>'
        f'<div class="body">{body}</div></main>'
        + (f"<script>{script}</script>" if script else "")
        + "</body></html>"
    )
