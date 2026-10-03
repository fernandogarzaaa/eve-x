#!/usr/bin/env bash
set -u
H="Authorization: Bearer qual-canonical-token-0123456789abcdef"
curl -sf -H "$H" http://127.0.0.1:8080/v1/sessions | python3 -c "import json,sys; [print(s['id'], s['vmId'], s['status'], s['createdAt']) for s in json.load(sys.stdin)['sessions']]"
echo "--- workdirs ---"
ls -dt /var/lib/eve-images/qual/vm-* 2>/dev/null
echo "--- qemu procs ---"
ps -eo pid,etime,args | grep qemu-system | grep -v grep | cut -c1-160
