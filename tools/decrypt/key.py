#!/usr/bin/env python3
"""spade_a (base64) -> content key (32 hex). 纯字节变换，无第三方依赖。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import unwrap_spade

if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("usage: key.py <spade_a_base64>")
    print(unwrap_spade.spade_to_key(sys.argv[1].strip()))
