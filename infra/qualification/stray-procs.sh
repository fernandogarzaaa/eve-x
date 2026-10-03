#!/usr/bin/env bash
ps -eo pid,etime,args | grep -E "python3|qga-sync" | grep -v grep | head -10
echo "--- node procs ---"
ps -eo pid,etime,args | grep "infra/qualification" | grep -v grep | head -10
