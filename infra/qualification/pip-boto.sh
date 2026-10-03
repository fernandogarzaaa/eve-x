#!/usr/bin/env bash
set -u
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq python3-pip 2>&1 | tail -1
python3 -m pip install --quiet --break-system-packages boto3 2>&1 | tail -1
python3 -c "import boto3; print('boto3 ok')"
