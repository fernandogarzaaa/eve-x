#!/usr/bin/env bash
# QGA sync check against the canonical session workdir.
set -u
SOCK=$(ls -d /var/lib/eve-images/qual/vm-*/qga.sock 2>/dev/null | head -1)
echo "sock=$SOCK"
python3 - "$SOCK" <<'EOF'
import socket, json, sys
s = socket.socket(socket.AF_UNIX); s.settimeout(10); s.connect(sys.argv[1])
s.sendall(b'{"execute":"guest-sync","arguments":{"id":99}}\n')
data = b""
while b"\n" not in data:
    data += s.recv(4096)
print("SYNC:", data.decode().strip()[:100])
s.sendall(b'{"execute":"guest-exec","arguments":{"path":"/bin/hostname","arg":[],"capture-output":true}}\n')
data = b""
while b"\n" not in data:
    data += s.recv(4096)
print("EXEC:", data.decode().strip()[:160])
EOF
