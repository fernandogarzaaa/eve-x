#!/usr/bin/env bash
# Inspect canonical session VM state + API log tail.
set -u
H="Authorization: Bearer qual-canonical-token-0123456789abcdef"
curl -sf -H "$H" http://127.0.0.1:8080/v1/sessions/sess-d054467c
echo
ls /var/lib/eve-images/qual/
tail -5 /root/evex-prod/logs/api.log
ps aux | grep qemu-system | grep -v grep | wc -l
