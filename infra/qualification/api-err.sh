#!/usr/bin/env bash
grep -E '"level":"error"' /root/evex-prod/logs/api.log | tail -6 | cut -c1-300
echo "--- fork audit for latest VM ---"
