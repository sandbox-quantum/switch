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
# So render something. Closing the tab is attempted but cannot be relied on:
# browsers only let a script close a window that a script opened, and this one
# was opened by a click in Teams. When the close is refused the page says the
# handover worked and the tab can go — which is the true statement the blank
# redirect never made.
#
# The target is interpolated into an href and read back out of the DOM rather
# than written into a script. This endpoint is public and its query string comes
# from whoever clicked, so the escaping is load-bearing; the scheme and host are
# fixed constants, leaving no way to point the anchor at another scheme.
_HANDOFF_PAGE = """<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Opening Switch Console</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body {{ font: 16px/1.5 system-ui, sans-serif; margin: 0; display: grid;
         place-items: center; min-height: 100vh; text-align: center;
         color: #1a1a1a; background: #fafafa; }}
  @media (prefers-color-scheme: dark) {{
    body {{ color: #f0f0f0; background: #141414; }}
  }}
  main {{ padding: 2rem; max-width: 28rem; }}
  p {{ margin: 0.5rem 0; }}
  .muted {{ opacity: 0.7; font-size: 0.9em; }}
</style>
<main>
  <p id="status">Opening Switch Console…</p>
  <p class="muted">
    <a id="target" href="{target}">Open it manually</a> if nothing happens.
  </p>
</main>
<script>
  var target = document.getElementById("target");
  var status = document.getElementById("status");
  window.location.href = target.href;
  window.setTimeout(function () {{
    window.close();
    status.textContent = "Switch Console is open. You can close this tab.";
  }}, 500);
</script>
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
