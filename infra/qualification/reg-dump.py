import json
import sys
with open("/root/evex-prod/data/vm-registry.json") as f:
    d = json.load(f)
print("top keys:", list(d.keys()))
ents = d.get("entries", {})
print("entry ids:", list(ents.keys()))
if ents:
    first = next(iter(ents.values()))
    print(json.dumps(first, indent=1)[:900])
