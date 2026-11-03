"""A one-file web chat that talks to Switch through the webhook platform.

    SWITCH_EVENTS_URL=https://switch.example/messaging/bridges/<id>/events \
    SWITCH_TOKEN=<inbound token> \
    SWITCH_SIGNING_SECRET=<signing secret> \
    python app.py

Open http://localhost:8081, press "Add Switch to this channel", and talk to the
agents in the room. Needs only the Python standard library.
"""

import hashlib
import hmac
import json
import os
import queue
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

EVENTS_URL = os.environ["SWITCH_EVENTS_URL"]
TOKEN = os.environ["SWITCH_TOKEN"]
SIGNING_SECRET = os.environ["SWITCH_SIGNING_SECRET"]
PORT = int(os.environ.get("PORT", "8081"))
CHANNEL = {"id": "general", "name": "General", "type": "channel"}
MAX_CLOCK_SKEW = 300

messages: dict[str, dict] = {}
order: list[str] = []
subscribers: list[queue.Queue] = []
lock = threading.Lock()


def publish(update: dict) -> None:
    with lock:
        for box in subscribers:
            box.put(update)


def signature_is_valid(headers, body: bytes) -> bool:
    stamp = headers.get("X-Switch-Timestamp", "")
    if not stamp.isdigit() or abs(time.time() - int(stamp)) > MAX_CLOCK_SKEW:
        return False
    digest = hmac.new(
        SIGNING_SECRET.encode(), stamp.encode() + b"." + body, hashlib.sha256
    )
    return hmac.compare_digest(
        "v1=" + digest.hexdigest(), headers.get("X-Switch-Signature", "")
    )


def apply_from_switch(event: dict) -> None:
    kind = event["type"]
    if kind == "message.created":
        message = {
            "id": event["message_id"],
            "sender": event["sender"]["name"],
            "text": event.get("text", ""),
            "thread_id": event.get("thread_id"),
            "files": [
                {"name": f["filename"], "type": f["mimetype"], "data": f["data"]}
                for f in event.get("files", [])
            ],
            "mine": False,
        }
        with lock:
            messages[message["id"]] = message
            order.append(message["id"])
        publish({"kind": "created", "message": message})
    elif kind == "message.updated" and event["message_id"] in messages:
        messages[event["message_id"]]["text"] = event["text"]
        publish({"kind": "updated", "id": event["message_id"], "text": event["text"]})
    elif kind == "message.deleted" and event["message_id"] in messages:
        with lock:
            messages.pop(event["message_id"])
            order.remove(event["message_id"])
        publish({"kind": "deleted", "id": event["message_id"]})
    elif kind == "typing":
        publish(
            {
                "kind": "typing",
                "sender": event["sender"]["name"],
                "on": event["is_typing"],
            }
        )


def post_to_switch(event: dict) -> int:
    request = urllib.request.Request(
        EVENTS_URL,
        data=json.dumps(event).encode(),
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


def send_from_user(body: dict) -> int:
    event_id = f"evt-{uuid.uuid4().hex}"
    name = body.get("name") or "Guest"
    files = body.get("files", [])
    message = {
        "id": event_id,
        "sender": name,
        "text": body.get("text", ""),
        "thread_id": body.get("thread_id"),
        "files": [
            {"name": f["filename"], "type": f["mimetype"], "data": f["data"]}
            for f in files
        ],
        "mine": True,
    }
    with lock:
        messages[event_id] = message
        order.append(event_id)
    publish({"kind": "created", "message": message})
    return post_to_switch(
        {
            "version": 1,
            "id": event_id,
            "type": "message",
            "channel": CHANNEL,
            "sender": {"id": name.lower().replace(" ", "-"), "name": name},
            "message": {
                "id": event_id,
                "text": message["text"],
                "thread_id": message["thread_id"],
                "files": files,
            },
        }
    )


def join_channel() -> int:
    return post_to_switch(
        {
            "version": 1,
            "id": f"evt-{uuid.uuid4().hex}",
            "type": "channel.joined",
            "channel": CHANNEL,
        }
    )


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args) -> None:
        pass

    def _reply(self, status: int, body: bytes = b"", kind: str = "text/plain") -> None:
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read(self) -> bytes:
        return self.rfile.read(int(self.headers.get("Content-Length", 0)))

    def do_GET(self) -> None:
        if self.path == "/":
            self._reply(200, PAGE.encode(), "text/html; charset=utf-8")
        elif self.path == "/stream":
            self.stream()
        else:
            self._reply(404)

    def do_POST(self) -> None:
        body = self._read()
        if self.path == "/switch":
            if not signature_is_valid(self.headers, body):
                return self._reply(401)
            event = json.loads(body)
            if event["type"] != "ping":
                apply_from_switch(event)
            self._reply(200)
        elif self.path == "/send":
            self._reply(send_from_user(json.loads(body)))
        elif self.path == "/join":
            self._reply(join_channel())
        else:
            self._reply(404)

    def stream(self) -> None:
        box: queue.Queue = queue.Queue()
        with lock:
            subscribers.append(box)
            snapshot = [messages[i] for i in order]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            self._push({"kind": "snapshot", "messages": snapshot})
            while True:
                try:
                    self._push(box.get(timeout=15))
                except queue.Empty:
                    self.wfile.write(b": keep-alive\n\n")
                    self.wfile.flush()
        except OSError:
            pass
        finally:
            with lock:
                subscribers.remove(box)

    def _push(self, update: dict) -> None:
        self.wfile.write(b"data: " + json.dumps(update).encode() + b"\n\n")
        self.wfile.flush()


PAGE = """<!doctype html>
<meta charset="utf-8"><title>Webhook chat</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem;color:#1c1c1c}
#log{border:1px solid #ddd;border-radius:8px;height:380px;overflow:auto;padding:.75rem}
.msg{margin:.4rem 0}.msg b{margin-right:.4rem}.mine b{color:#2563eb}.meta{color:#777;font-size:12px}
form{display:flex;gap:.5rem;margin-top:.75rem}input[type=text]{flex:1;padding:.5rem}button{padding:.5rem .8rem}
#typing{height:1.2rem;color:#777;font-size:13px}
</style>
<h2>Webhook chat <button id="join">Add Switch to this channel</button></h2>
<div id="log"></div><div id="typing"></div>
<form id="form">
  <input id="name" type="text" value="Guest" size="8" aria-label="Your name">
  <input id="text" type="text" placeholder="Message, or @agent to talk to one" autocomplete="off" aria-label="Message">
  <input id="file" type="file" aria-label="Attach a file">
  <button>Send</button>
</form>
<script>
const log = document.getElementById("log"), typing = document.getElementById("typing");
let thread = null;
function render(m) {
  const el = document.createElement("div");
  el.className = "msg" + (m.mine ? " mine" : ""); el.id = "m-" + m.id;
  const files = m.files.map(f => ` <a download="${f.name}" href="data:${f.type};base64,${f.data}">${f.name}</a>`).join("");
  el.innerHTML = `<b></b><span class="t"></span>${files}<span class="meta"> <a href="#" data-r="${m.id}">reply</a></span>`;
  el.querySelector("b").textContent = m.sender;
  el.querySelector(".t").textContent = (m.thread_id ? "↳ " : "") + m.text;
  el.querySelector("[data-r]").onclick = e => { e.preventDefault(); thread = m.thread_id || m.id; document.getElementById("text").focus(); };
  log.appendChild(el); log.scrollTop = log.scrollHeight;
}
const source = new EventSource("/stream");
source.onmessage = e => {
  const u = JSON.parse(e.data);
  if (u.kind === "snapshot") { log.innerHTML = ""; u.messages.forEach(render); }
  else if (u.kind === "created") render(u.message);
  else if (u.kind === "updated") document.querySelector("#m-" + u.id + " .t").textContent = u.text;
  else if (u.kind === "deleted") document.getElementById("m-" + u.id)?.remove();
  else if (u.kind === "typing") typing.textContent = u.on ? u.sender + " is typing…" : "";
};
document.getElementById("join").onclick = () => fetch("/join", {method: "POST"});
document.getElementById("form").onsubmit = async e => {
  e.preventDefault();
  const text = document.getElementById("text"), picked = document.getElementById("file").files[0];
  const files = picked ? [{filename: picked.name, mimetype: picked.type || "application/octet-stream",
    data: btoa(String.fromCharCode(...new Uint8Array(await picked.arrayBuffer())))}] : [];
  if (!text.value && !files.length) return;
  await fetch("/send", {method: "POST", body: JSON.stringify({name: document.getElementById("name").value, text: text.value, thread_id: thread, files})});
  text.value = ""; document.getElementById("file").value = ""; thread = null;
};
</script>
"""

if __name__ == "__main__":
    print(f"Webhook chat on http://localhost:{PORT} (Switch posts to /switch)")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
