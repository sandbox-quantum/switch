from __future__ import annotations

from html import escape

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse

from switch_core.deeplinks import gateway_query_to_switchdash
from switch_core.web_page import render_page, status_icon

router = APIRouter()


# Handing a browser off to a desktop app leaves a tab behind, and what that tab
# shows is whatever it last rendered. A 302 renders nothing, so the tab kept the
# page it came from — on Teams, Defender's Safe Links interstitial, still saying
# "Verifying link . . ." long after Switch Console had opened. It reads as a
# link that hung.
#
# So render a branded two-state page. State 1 ("Waiting") shows a pulsing icon
# and a manual-open link; state 2 ("Opened") replaces the icon with a checkmark
# once the user switches to the app (detected via visibilitychange). No
# window.close() — Discord opens external links in a way that lets close()
# succeed, killing the tab before the OS protocol-handler dialog can be acted on.
#
# The target is interpolated into an href and read back out of the DOM rather
# than written into a script. This endpoint is public and its query string comes
# from whoever clicked, so the escaping is load-bearing; the scheme and host are
# fixed constants, leaving no way to point the anchor at another scheme.
_HANDOFF_ICON = (
    '<div id="logo"><div class="status info pulse"><svg viewBox="0 0 24 24" aria-hidden="true">'
    '<path d="M14 5h5v5"/><path d="M19 5l-8 8"/>'
    '<path d="M17 13.5V18a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4.5"/>'
    "</svg></div></div>"
    f'<div id="check" hidden>{status_icon("success")}</div>'
)

_HANDOFF_SCRIPT = """
  (function () {
    var target = document.getElementById("target");
    var title = document.getElementById("title");
    var subtitle = document.getElementById("subtitle");
    var logo = document.getElementById("logo");
    var check = document.getElementById("check");

    window.location.href = target.href;

    window.setTimeout(function () {
      subtitle.textContent = "Didn’t see a prompt? Click the link below.";
    }, 4000);

    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        logo.style.display = "none";
        check.style.display = "block";
        title.textContent = "Switch Console is open";
        subtitle.textContent = "You can close this tab.";
      }
    });
  })();
"""


def handoff_page(target: str) -> str:
    return render_page(
        title="Opening Switch Console…",
        icon=_HANDOFF_ICON,
        body=(
            '<p id="subtitle">Your browser should prompt you to open the app.</p>'
            '<div class="actions"><a id="target" class="button secondary" '
            f'href="{escape(target, quote=True)}">Open manually</a></div>'
        ),
        script=_HANDOFF_SCRIPT,
    )


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
    return HTMLResponse(handoff_page(target))
