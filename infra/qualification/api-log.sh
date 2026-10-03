#!/usr/bin/env bash
grep -E -m10 "fork|driver_failed|FAILED|QEMU_CLONE" /root/evex-prod/logs/api.log | cut -c1-220
echo "--- tail ---"
tail -4 /root/evex-prod/logs/api.log | cut -c1-220
