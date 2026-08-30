# -*- coding: utf-8 -*-
"""签发服务器证书 server.crt（nginx 8443 与后端 8000 端口共用）。

用法: python gen_server.py  (需 openssl 在 PATH 中)
输出: server.key / server.crt（覆盖旧文件）

设计要点:
- SAN = localhost / 127.0.0.1；如改为通过服务器 IP/域名访问，
  修改下方 SAN 列表后重签即可消除浏览器告警。
- 不含 CRL 分发点扩展 —— 已取消 CRL 吊销检查（客户端不再拉取 CRL，
  也避免了 SCHANNEL 拉取失败的超时等待）。
- subject 通过 UTF-8 配置文件传给 openssl req（Windows 下 argv 传递
  中文会经 ANSI 代码页转换损坏），不经过命令行参数。
"""
import os
import subprocess
import sys

OPENSSL = "openssl"
CA_CNF = "ca_openssl.cnf"

# 服务器证书 SAN：改为实际访问地址
#   例: ["DNS:localhost", "IP:127.0.0.1", "IP:192.168.1.100", "DNS:wiki.example.com"]
SAN = ["DNS:localhost", "IP:127.0.0.1"]

os.chdir(os.path.dirname(os.path.abspath(__file__)))


def run(args: list[str]) -> subprocess.CompletedProcess:
    r = subprocess.run(args, capture_output=True)
    if r.returncode != 0:
        sys.stderr.write(r.stderr.decode("utf-8", "replace") + "\n")
        raise SystemExit(f"FAILED: {' '.join(args)}")
    return r


# 服务器证书扩展：serverAuth EKU + SAN，不含 CRL 分发点（已取消吊销检查）
ext_cnf = "tmp_server_ext.cnf"
with open(ext_cnf, "w", encoding="utf-8") as f:
    f.write(
        "[ server_ext ]\n"
        "basicConstraints = CA:FALSE\n"
        "keyUsage = digitalSignature, keyEncipherment\n"
        "extendedKeyUsage = serverAuth\n"
        "subjectAltName = " + ",".join(SAN) + "\n"
    )

# subject 写入 UTF-8 配置文件，避开 argv 编码问题（与 gen_clients.py 同理）
req_cnf = "tmp_server_req.cnf"
with open(req_cnf, "w", encoding="utf-8") as f:
    f.write(
        "[ req ]\n"
        "distinguished_name = dn\n"
        "prompt = no\n"
        "\n"
        "[ dn ]\n"
        "C = CN\n"
        "ST = 32\n"
        "L = 00\n"
        "O = 11\n"
        "OU = 00\n"
        "CN = localhost\n"
    )

# ca.srl 缺失时（如 CA 数据库刚清空）从 1001 重新开始编号
if not os.path.exists("ca.srl"):
    with open("ca.srl", "w") as f:
        f.write("1001")

run([OPENSSL, "genrsa", "-out", "server.key", "2048"])
run([OPENSSL, "req", "-new", "-utf8", "-config", req_cnf, "-key", "server.key",
     "-out", "tmp_server.csr"])
run([OPENSSL, "ca", "-config", CA_CNF, "-batch", "-notext", "-days", "3650",
     "-extfile", ext_cnf, "-extensions", "server_ext",
     "-in", "tmp_server.csr", "-out", "server.crt"])
os.remove(req_cnf)
os.remove(ext_cnf)
os.remove("tmp_server.csr")

v = run([OPENSSL, "x509", "-in", "server.crt", "-noout",
         "-ext", "subjectAltName", "-ext", "extendedKeyUsage"])
print(v.stdout.decode("utf-8", "replace"))
print("[done] server.key / server.crt regenerated (no CRL DP)")
