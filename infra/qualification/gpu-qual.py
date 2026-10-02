"""EVE-X GPU qualification: real CUDA training + inference measurement (RTX 2060)."""
import json, time, torch
import torch.nn as nn

info = {
    "torch": torch.__version__,
    "cuda_available": torch.cuda.is_available(),
    "device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu",
    "capability": list(torch.cuda.get_device_capability(0)) if torch.cuda.is_available() else None,
    "vram_total_mb": round(torch.cuda.get_device_properties(0).total_memory / 2**20, 1) if torch.cuda.is_available() else 0,
}
assert torch.cuda.is_available(), "CUDA required for GPU qualification"
dev = torch.device("cuda:0")
print(json.dumps(info, indent=1))

torch.manual_seed(42)
# Synthetic grounding-head-like task: bbox regression from a fake visual embedding.
model = nn.Sequential(nn.Linear(256, 128), nn.ReLU(), nn.Linear(128, 4)).to(dev)
opt = torch.optim.AdamW(model.parameters(), lr=1e-3)
loss_fn = nn.MSELoss()
X = torch.randn(4096, 256, device=dev)
Y = torch.rand(4096, 4, device=dev)
ds = torch.utils.data.TensorDataset(X, Y)
dl = torch.utils.data.DataLoader(ds, batch_size=256, shuffle=True)

t0 = time.perf_counter()
for ep in range(5):
    tot = 0.0
    for xb, yb in dl:
        opt.zero_grad()
        loss = loss_fn(model(xb), yb)
        loss.backward()
        opt.step()
        tot += loss.item()
    print(f"epoch {ep} loss {tot/len(dl):.4f}", flush=True)
train_s = time.perf_counter() - t0
torch.save({"model": model.state_dict(), "epoch": 5}, "gpu-ckpt.pt")

# Resume: reload + 1 more epoch (interrupt-resume pattern).
ckpt = torch.load("gpu-ckpt.pt", weights_only=True)
model.load_state_dict(ckpt["model"])
xb, yb = next(iter(dl))
opt.zero_grad(); loss_fn(model(xb), yb).backward(); opt.step()
print(f"resume ok from epoch {ckpt['epoch']}", flush=True)

# Inference latency (batch + single, synced).
model.eval()
with torch.inference_mode():
    for _ in range(10):
        model(torch.randn(32, 256, device=dev))
    torch.cuda.synchronize()
    t1 = time.perf_counter()
    for _ in range(100):
        model(torch.randn(32, 256, device=dev))
    torch.cuda.synchronize()
    batch_ms = (time.perf_counter() - t1) / 100 * 1000
print(json.dumps({
    "train_5_epochs_s": round(train_s, 2),
    "infer_batch32_ms": round(batch_ms, 2),
    "peak_vram_mb": round(torch.cuda.max_memory_allocated() / 2**20, 1),
}, indent=1))
