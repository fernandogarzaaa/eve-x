#!/usr/bin/env bash
# Show session VM mapping + serial tail + qga state for the newest session VM.
set -u
H="Authorization: Bearer qual-canonical-token-0123456789abcdef"
SJSON=$(curl -sf -H "$H" http://127.0.0.1:8080/v1/sessions | python3 -c "import json,sys; ss=json.load(sys.stdin)['sessions']; ss.sort(key=lambda s: s['createdAt']); s=ss[-1]; print(s['id'], s['vmId'])")
echo "latest session: $SJSON"
VMID=$(echo "$SJSON" | awk '{print $2}')
VJSON=$(curl -sf -H "$H" http://127.0.0.1:8080/v1/vms/$VMID)
echo "$VJSON" | python3 -c "import json,sys; v=json.load(sys.stdin); print('driver:', v.get('driverVmId'), 'backend:', v.get('backend'), 'state:', v.get('state'))"
DVMID=$(echo "$VJSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('driverVmId',''))")
D=/var/lib/eve-images/qual/$DVMID
echo "== console tail =="
tr -d '\000' < "$D/console.log" 2>/dev/null | tail -5
echo "== qga =="
python3 /root/qga-sync.py "$D/qga.sock" 2>&1 | head -3
