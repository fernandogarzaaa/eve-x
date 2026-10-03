import socket
import sys

sock = sys.argv[1]
s = socket.socket(socket.AF_UNIX)
s.settimeout(10)
s.connect(sock)
s.sendall(b'{"execute":"guest-sync","arguments":{"id":99}}\n')
data = b""
while b"\n" not in data:
    data += s.recv(4096)
print("SYNC:", data.decode().strip()[:100])
