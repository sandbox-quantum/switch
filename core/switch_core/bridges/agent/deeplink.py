from __future__ import annotations

from html import escape

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse

from switch_core.deeplinks import gateway_query_to_switchdash

router = APIRouter()


# Handing a browser off to a desktop app leaves a tab behind, and what that tab
# shows is whatever it last rendered. A 302 renders nothing, so the tab kept the
# page it came from — on Teams, Defender's Safe Links interstitial, still saying
# "Verifying link . . ." long after Switch Console had opened. It reads as a
# link that hung.
#
# So render a branded two-state page. State 1 ("Waiting") shows a pulsing logo
# and a manual-open link; state 2 ("Opened") replaces the logo with a checkmark
# once the user switches to the app (detected via visibilitychange). No
# window.close() — Discord opens external links in a way that lets close()
# succeed, killing the tab before the OS protocol-handler dialog can be acted on.
#
# The target is interpolated into an href and read back out of the DOM rather
# than written into a script. This endpoint is public and its query string comes
# from whoever clicked, so the escaping is load-bearing; the scheme and host are
# fixed constants, leaving no way to point the anchor at another scheme.
_HANDOFF_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Opening Switch Console</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body {{
    font: 16px/1.5 system-ui, -apple-system, sans-serif;
    margin: 0; display: grid; place-items: center; min-height: 100vh;
    text-align: center; color: #0d0806; background: #f9f7f5;
  }}
  @media (prefers-color-scheme: dark) {{
    body {{ color: #fafafa; background: #09090b; }}
  }}
  main {{ padding: 2rem; max-width: 28rem; }}
  .icon {{ width: 64px; height: 64px; margin: 0 auto 1.5rem; }}
  @keyframes pulse {{
    0%, 100% {{ opacity: 1; }}
    50% {{ opacity: 0.5; }}
  }}
  #logo {{ animation: pulse 2s ease-in-out infinite; }}
  #check {{ display: none; }}
  h1 {{ font-size: 1.25rem; font-weight: 600; margin: 0 0 0.25rem; }}
  #subtitle {{ margin: 0.25rem 0 1.5rem; opacity: 0.7; font-size: 0.95em; }}
  .manual-link {{
    color: #243a31; text-decoration: underline;
    text-underline-offset: 2px; font-size: 0.9em;
  }}
  #check circle {{ fill: #009966; }}
  #check path {{ stroke: #009966; }}
  @media (prefers-color-scheme: dark) {{
    .manual-link {{ color: #A1C9D2; }}
    #check circle {{ fill: #00bc7d; }}
    #check path {{ stroke: #00bc7d; }}
  }}
</style>
</head>
<body>
<main>
  <div class="icon">
    <svg id="logo" viewBox="0 0 102 102" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M24.5117 65.6279C26.997 65.6279 29.0117 67.6426 29.0117 70.1279V77.1279C29.0117 79.6132 26.997 81.6279 24.5117 81.6279C22.0264 81.6279 20.0117 79.6132 20.0117 77.1279V70.1279C20.0117 67.6426 22.0264 65.6279 24.5117 65.6279Z"/>
      <path d="M42.5117 65.6279C44.997 65.6279 47.0117 67.6426 47.0117 70.1279V77.1279C47.0117 79.6132 44.997 81.6279 42.5117 81.6279C40.0264 81.6279 38.0117 79.6132 38.0117 77.1279V70.1279C38.0117 67.6426 40.0264 65.6279 42.5117 65.6279Z"/>
      <path d="M59.3174 20.1826C61.8027 20.1826 63.8174 22.1973 63.8174 24.6826V31.6826C63.8174 34.1679 61.8027 36.1826 59.3174 36.1826C56.8321 36.1826 54.8174 34.1679 54.8174 31.6826V24.6826C54.8174 22.1973 56.8321 20.1826 59.3174 20.1826Z"/>
      <path d="M77.3174 20.1826C79.8027 20.1826 81.8174 22.1973 81.8174 24.6826V31.6826C81.8174 34.1679 79.8027 36.1826 77.3174 36.1826C74.8321 36.1826 72.8174 34.1679 72.8174 31.6826V24.6826C72.8174 22.1973 74.8321 20.1826 77.3174 20.1826Z"/>
      <path fill-rule="evenodd" clip-rule="evenodd" d="M89.8232 0C96.4507 0 101.823 5.37258 101.823 12V74.2256C101.823 77.4082 100.559 80.4605 98.3086 82.7109L82.7109 98.3086C80.4605 100.559 77.4082 101.823 74.2256 101.823H12C5.37259 101.823 0 96.4507 0 89.8232V27.5977C0 24.4151 1.26425 21.3627 3.51465 19.1123L19.1123 3.51465C21.3627 1.26425 24.4151 0 27.5977 0H89.8232ZM16 56.4121C13.2386 56.4121 11 58.6507 11 61.4121V84.8232C11 88.1369 13.6863 90.8232 17 90.8232H69.6689C72.8515 90.8232 75.9039 89.559 78.1543 87.3086L87.3086 78.1543C89.559 75.9039 90.8232 72.8515 90.8232 69.6689V61.4121C90.8232 58.6507 88.5847 56.4121 85.8232 56.4121H16ZM32.1543 11C28.9717 11 25.9194 12.2642 23.6689 14.5146L14.5146 23.6689C12.2643 25.9194 11 28.9717 11 32.1543V40.4121C11 43.1735 13.2386 45.4121 16 45.4121H85.8232C88.5847 45.4121 90.8232 43.1735 90.8232 40.4121V17C90.8232 13.6863 88.1369 11 84.8232 11H32.1543Z"/>
    </svg>
    <svg id="check" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
      <circle cx="32" cy="32" r="30" fill-opacity="0.15"/>
      <path d="M20 33 L28 41 L44 23" fill="none" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </div>
  <h1 id="title">Opening Switch Console…</h1>
  <p id="subtitle">Your browser should prompt you to open the app.</p>
  <a id="target" class="manual-link" href="{target}">Open manually</a>
</main>
<script>
  (function () {{
    var target = document.getElementById("target");
    var title = document.getElementById("title");
    var subtitle = document.getElementById("subtitle");
    var logo = document.getElementById("logo");
    var check = document.getElementById("check");

    window.location.href = target.href;

    window.setTimeout(function () {{
      subtitle.textContent = "Didn’t see a prompt? Click the link below.";
    }}, 4000);

    document.addEventListener("visibilitychange", function () {{
      if (document.hidden) {{
        logo.style.display = "none";
        check.style.display = "block";
        title.textContent = "Switch Console is open";
        subtitle.textContent = "You can close this tab.";
      }}
    }});
  }})();
</script>
</body>
</html>
"""


@router.get("/deeplink/session")
async def redirect_session_deeplink(request: Request) -> HTMLResponse:
    """Hand the browser off to the `switchdash://session?…` deeplink.

    Platforms that only linkify http(s) (Teams, Discord, …) can't render the raw
    custom-scheme deeplink, so the bridge posts this https URL instead and the
    click lands here. The incoming query string is carried across verbatim; the
    scheme and host of the target are fixed constants, so this cannot be coerced
    into an open redirect. Public by design — the link is followed by whoever
    clicks it in the external channel, and it serves no data beyond the handoff
    (its `/deeplink` prefix is in the Bearer middleware's public allowlist).
    """
    target = gateway_query_to_switchdash(request.url.query)
    return HTMLResponse(_HANDOFF_PAGE.format(target=escape(target, quote=True)))
