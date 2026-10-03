#!/usr/bin/env bash
set -u
H="Authorization: Bearer qual-canonical-token-0123456789abcdef"
curl -sf -H "$H" http://127.0.0.1:8080/v1/vms | python3 -c "import json,sys; [print(v['id'], v.get('driverVmId'), v.get('backend'), v.get('state')) for v in json.load(sys.stdin)['vms']]"
