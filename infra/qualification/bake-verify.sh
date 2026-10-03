#!/usr/bin/env bash
# Verify bake guest contents via QGA channel, then seal.
set -u
SOCK="${1:?qga.sock path}"
qga() {
  python3 - "$SOCK" "$@" <<'EOF'
import socket, json, sys, base64, time
sock, args = sys.argv[1], sys.argv[2:]
s = socket.socket(socket.AF_UNIX); s.settimeout(20); s.connect(sock)
seq = [0]
def cmd(payload):
    seq[0] += 1
    msg = {"execute": payload[0], "arguments": payload[1], "id": seq[0]}
    s.sendall((json.dumps(msg) + "\n").encode())
    data = b""
    while b"\n" not in data:
        data += s.recv(65536)
    return json.loads(data.decode())["return"]
cmd(("guest-sync", {"id": 7}))
ex = cmd(("guest-exec", {"path": args[0], "arg": args[1:], "capture-output": True}))
pid = ex["pid"]
for _ in range(40):
    st = cmd(("guest-exec-status", {"pid": pid}))
    if st.get("exited"):
        out = base64.b64decode(st.get("out-data", "")).decode(errors="replace")
        print(f"exit={st.get('exitcode')} :: {out.strip()[:400]}")
        break
    time.sleep(3)
else:
  print("TIMEOUT")
EOF
}
echo "== qga ping =="; qga /bin/hostname
echo "== desktop packages =="; qga /usr/bin/dpkg-query -W -f='${Status}\n' gdm3 gnome-shell ubuntu-desktop-minimal
echo "== firefox =="; qga /bin/sh -c "command -v firefox || ls /snap/bin/firefox 2>/dev/null || echo NO-FIREFOX"
echo "== qga service =="; qga /bin/systemctl is-active qemu-guest-agent
echo "== disk use =="; qga /bin/df -h /
