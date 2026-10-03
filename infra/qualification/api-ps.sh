#!/usr/bin/env bash
ps -eo pid,etime,args | grep "apps/api" | grep -v grep | cut -c1-120
echo "--- registry ---"
cat /root/evex-prod/data/vm-registry.json 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(list(d.get('entries', d) if isinstance(d, dict) else d)[:8])" 2>&1 | head -5
ls /root/evex-prod/data/ 2>/dev/null
