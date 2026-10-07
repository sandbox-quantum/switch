#!/usr/bin/python3
"""ExecStartPost of the gate's switch-machine-boot drop-in: points the
controller's KMS client at moto through the controller configuration's
`kms.endpoint` test override, keeping the file's owner and mode."""

import json
import os

PATH = "/run/switch-machine/controller.json"
ENDPOINT = "http://127.0.0.1:5000"

details = os.stat(PATH)
value = json.load(open(PATH))
value["kms"]["endpoint"] = ENDPOINT
temporary = PATH + ".cc-gate"
with open(temporary, "w") as handle:
    json.dump(value, handle, indent=2, sort_keys=True)
    handle.write("\n")
os.chown(temporary, details.st_uid, details.st_gid)
os.chmod(temporary, details.st_mode & 0o7777)
os.replace(temporary, PATH)
