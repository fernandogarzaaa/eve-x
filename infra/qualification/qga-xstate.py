import socket
import sys
import json
import base64
import time

sock = sys.argv[1]
s = socket.socket(socket.AF_UNIX)
s.settimeout(15)
s.connect(sock)
seq = [300]


def cmd(execute, arguments):
    seq[0] += 1
    s.sendall((json.dumps({"execute": execute, "arguments": arguments, "id": seq[0]}) + "\n").encode())
    data = b""
    while b"\n" not in data:
        data += s.recv(65536)
    return json.loads(data.decode())["return"]


def sh(command):
    ex = cmd("guest-exec", {"path": "/bin/sh", "arg": ["-c", command], "capture-output": True})
    for _ in range(20):
        st = cmd("guest-exec-status", {"pid": ex["pid"]})
        if st.get("exited"):
            out = base64.b64decode(st.get("out-data", "")).decode(errors="replace")
            return st.get("exitcode"), out.strip()[:600]
        time.sleep(2)
    return -1, "TIMEOUT"


cmd("guest-sync", {"id": 7})
code, out = sh("ls /tmp/.X11-unix/ 2>&1; pgrep -a Xorg | cut -c1-80")
print("X:", out)
code, out = sh("C=$(find /run -maxdepth 4 -name Xauthority 2>/dev/null | head -1); echo cookie=$C; XAUTHORITY=$C DISPLAY=:0 xrandr 2>&1 | head -4")
print("XRANDR:", out)
