import socket
import sys
import json
import base64
import time

sock = sys.argv[1]
s = socket.socket(socket.AF_UNIX)
s.settimeout(15)
s.connect(sock)
seq = [200]


def cmd(execute, arguments):
    seq[0] += 1
    s.sendall((json.dumps({"execute": execute, "arguments": arguments, "id": seq[0]}) + "\n").encode())
    data = b""
    while b"\n" not in data:
        data += s.recv(65536)
    return json.loads(data.decode())["return"]


cmd("guest-sync", {"id": 7})
ex = cmd("guest-exec", {"path": "/bin/grep", "arg": ["-m10", "-E", "EE|WW|modesetting|glamor|No devices detected", "/var/log/Xorg.0.log"], "capture-output": True})
for _ in range(20):
    st = cmd("guest-exec-status", {"pid": ex["pid"]})
    if st.get("exited"):
        out = base64.b64decode(st.get("out-data", "")).decode(errors="replace")
        print(f"exit={st.get('exitcode')} ::\n{out[:1500]}")
        break
    time.sleep(2)
