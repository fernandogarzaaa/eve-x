#!/usr/bin/env bash
ss -x 2>/dev/null | grep -m10 qmp || echo "no ss match"
echo "--- sock files ---"
ls -la /var/lib/eve-images/qual/*/qmp.sock 2>/dev/null
