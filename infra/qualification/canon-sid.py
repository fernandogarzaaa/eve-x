import json
import glob
import os
cands = sorted(glob.glob("/root/evex-prod/artifacts/qualification/canonical-e2e.json"))
if cands:
    d = json.load(open(cands[0]))
    print(d.get("sessionId"), d.get("vmId"))
else:
    print("NO-CANONICAL-JSON")
    print(os.listdir("/root/evex-prod/artifacts/qualification"))
