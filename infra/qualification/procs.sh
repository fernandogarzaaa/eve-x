#!/usr/bin/env bash
ps -eo pid,etime,args | grep -E "apps/worker|apps/api" | grep -v grep | cut -c1-120
echo PROCS-DONE
