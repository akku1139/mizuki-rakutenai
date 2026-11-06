# SPDX-License-Identifier: AGPL-3.0-or-later

"""KevのCPU用backboneだけを動的INT8量子化し、公式のHTTPサーバーで配信する。"""

import os
import sys


def quantize_backbone(model, torch):
  # 判定headと埋め込みはFP32のまま残す。Qwen3の全結合層だけを置き換える。
  model.lm = torch.ao.quantization.quantize_dynamic(
    model.lm, {torch.nn.Linear}, dtype=torch.qint8, inplace=False,
  )
  count = sum(isinstance(m, torch.ao.nn.quantized.dynamic.Linear) for m in model.lm.modules())
  if not count:
    raise RuntimeError("INT8に置き換えられるLinearがありません")
  print(f"INT8 Linear layers: {count}", flush=True)
  return model


def self_check():
  import torch
  from types import SimpleNamespace
  torch.manual_seed(0)
  model = SimpleNamespace(lm=torch.nn.Sequential(torch.nn.Linear(8, 4)).eval())
  sample = torch.randn(2, 8)
  expected = model.lm(sample)
  quantize_backbone(model, torch)
  torch.testing.assert_close(model.lm(sample), expected, atol=0.03, rtol=0.03)
  print("INT8量子化と推論: OK")


def main():
  if "--self-check" in sys.argv:
    self_check()
    return
  # Qwen3.5のハイブリッド層は対象外。全attentionのKev-0.6Bを固定して使う。
  os.environ.update(KEV_BACKEND="torch", KEV_DTYPE="fp32", KEV_FUSED="0", KEV_CUDA_GRAPHS="0")
  import torch
  from kev.checkpoint import Checkpoint
  from kev import serve
  load = Checkpoint.load

  def load_int8(checkpoint, device, opts):
    if device != "cpu":
      raise ValueError("この量子化サーバーは --device cpu 専用です")
    tokenizer, model = load(checkpoint, device, opts)
    if model.hybrid:
      raise ValueError("Qwen3.5ではなく jaredpalmer/kev-0.6b を指定してください")
    return tokenizer, quantize_backbone(model, torch)

  Checkpoint.load = load_int8
  sys.argv = [sys.argv[0], "--run", "jaredpalmer/kev-0.6b@dece6dba8d43f0f7ded45e9f5b9df12474d90843", "--device", "cpu", "--host", "127.0.0.1", "--port", "8009"]
  serve.main()


if __name__ == "__main__":
  main()
