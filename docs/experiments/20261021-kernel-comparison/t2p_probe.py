#!/usr/bin/env python3
"""Tool-to-Process attribution probe: marked 3-level process tree + 4 evidence points."""
import subprocess
import pathlib
import time

MARK = "AS_T2P_20261021"

# 1) 直接文件写（python 本体）
pathlib.Path(f"/tmp/{MARK}_direct.txt").write_text("direct write by python\n")

# 2) bash 子进程写 + 3) 孙进程 python 写
subprocess.run([
    "/bin/bash", "-c",
    f"echo child > /tmp/{MARK}_child.txt; "
    f"/usr/bin/python3 -c \"import pathlib;pathlib.Path('/tmp/{MARK}_grandchild.txt').write_text('grandchild')\"",
], check=True)

# 4) 网络连接（经 curl 子进程到本地 API）
subprocess.run([
    "/bin/bash", "-c",
    f"curl -s --max-time 3 --noproxy '*' http://127.0.0.1:29653/security-center/healthz > /tmp/{MARK}_net.txt || true",
], check=False)

time.sleep(1)
print(f"{MARK} done")
