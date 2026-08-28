# -*- coding: utf-8 -*-
"""签发客户端证书（***REMOVED***/谢林/谢林(2)/张胜利），CN = 姓名 18位身份证号。

用法: python gen_clients.py  (需 openssl 在 PATH 中)
输出: <name>.key / <name>.crt / <name>.p12 (密码 123456)

注意: subject 通过 UTF-8 配置文件传给 openssl req（Windows 下 argv 传递
中文会经 ANSI 代码页转换损坏），不经过命令行参数。
"""
import os
import subprocess
import sys

OPENSSL = "openssl"
CA_CNF = "ca_openssl.cnf"

USERS = [
    ("***REMOVED***",     "***REMOVED***"),
    ("xielin",       "谢林 320100198001010010"),
    ("xielin2",      "谢林 320200199011010011"),
    ("zhangshengli", "张胜利 320301198803210011"),
]

os.chdir(os.path.dirname(os.path.abspath(__file__)))


def run(args: list[str]) -> subprocess.CompletedProcess:
    r = subprocess.run(args, capture_output=True)
    if r.returncode != 0:
        sys.stderr.write(r.stderr.decode("utf-8", "replace") + "\n")
        raise SystemExit(f"FAILED: {' '.join(args)}")
    return r


# 吊销之前误签发（CN 编码损坏）的证书
def _revoke_if_valid(serial_file: str) -> None:
    if not os.path.exists(serial_file):
        return
    serial = serial_file.replace(".pem", "")
    # 先读完并关闭句柄，否则 openssl ca 重命名 index.txt 会失败
    with open("index.txt", encoding="utf-8", errors="replace") as f:
        lines = f.readlines()
    for line in lines:
        parts = line.split("\t")
        if len(parts) >= 4 and parts[3] == serial and parts[0].strip() == "V":
            run([OPENSSL, "ca", "-config", CA_CNF, "-revoke", serial_file])
            print(f"[revoked] {serial_file}")
            return
    print(f"[skip] {serial_file} (not valid in index.txt)")


for s in ("1002.pem", "1003.pem", "1004.pem", "1005.pem", "1006.pem", "1007.pem"):
    _revoke_if_valid(s)

verify_lines: list[bytes] = []

for name, cn in USERS:
    key, csr, crt, p12 = f"{name}.key", f"{name}.csr", f"{name}.crt", f"{name}.p12"
    req_cnf = f"tmp_{name}.cnf"

    # subject 写入 UTF-8 配置文件，避开 argv 编码问题
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
            f"CN = {cn}\n"
        )

    run([OPENSSL, "genrsa", "-out", key, "2048"])
    # -utf8: 将配置文件内容按 UTF-8 解释（Windows 下默认按 ANSI 代码页转换会损坏中文）
    run([OPENSSL, "req", "-new", "-utf8", "-config", req_cnf, "-key", key, "-out", csr])
    run([OPENSSL, "ca", "-config", CA_CNF, "-batch", "-notext", "-days", "3650",
         "-in", csr, "-out", crt])
    run([OPENSSL, "pkcs12", "-export", "-in", crt, "-inkey", key,
         "-out", p12, "-passout", "pass:123456"])
    os.remove(req_cnf)
    os.remove(csr)

    v = run([OPENSSL, "x509", "-in", crt, "-noout", "-subject", "-nameopt", "utf8"])
    verify_lines.append(v.stdout)
    print(f"[ok] {name}  ->  {crt} / {p12}")

# 校验结果写文件（避免控制台 GBK 编码问题），供人工确认
with open("verify_output.txt", "wb") as f:
    for line in verify_lines:
        f.write(line)
print("[done] see verify_output.txt")
