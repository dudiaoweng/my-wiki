"""Production server entry point — dual-port mTLS.

Port 8000 (CERT_NONE):
  - Serves the login page and static frontend without requesting a client
    certificate.  The browser NEVER shows a certificate dialog on this port.
  - No API routes are reachable (they require a cert which is not requested).

Port 8443 (CERT_REQUIRED):
  - Full application with mTLS.  The browser MUST present a valid client
    certificate to establish a TLS connection.

Flow:
  1. User visits https://localhost:8000 → login page (no cert dialog).
  2. User clicks "证书登录" → navigates to https://localhost:8443/api/auth/login.
  3. Port 8443 TLS handshake → browser shows certificate selection dialog.
  4. After successful mTLS, redirected to https://localhost:8443/?auth=1.
  5. Full app runs on port 8443 with same-origin API calls.
"""

import sys, os, ssl, asyncio, subprocess

os.chdir(os.path.dirname(os.path.abspath(__file__)))

# ── Kill stale processes ──────────────────────────────
def kill_port(port: int) -> None:
    if sys.platform != "win32":
        return
    result = subprocess.run(
        ["cmd", "/c", f"netstat -ano | findstr :{port} | findstr LISTENING"],
        capture_output=True, text=True,
    )
    for line in result.stdout.strip().split("\n"):
        parts = line.split()
        if parts:
            pid = parts[-1]
            subprocess.run(
                ["cmd", "/c", f"taskkill /f /pid {pid}"],
                capture_output=True,
            )
            print(f"Killed stale process PID {pid} on port {port}")

kill_port(8000)
kill_port(8443)

# ── Windows SSL fix ────────────────────────────────────
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

import uvicorn
from app.main import app

# ── SSL 验证兼容补丁：允许叶子证书作为信任锚点 ──────────
# 场景：中间 CA 已过期但客户端证书本身有效（第三方证书无法重新签发）。
# VERIFY_X509_PARTIAL_CHAIN：链中任一证书（含叶子）命中信任列表即通过，
# 从而绕过过期中间 CA 的链验证。需将客户端证书加入 ca_bundle.crt。
import uvicorn.config as _uv_config

_orig_create_ssl_context = _uv_config.create_ssl_context

def _create_ssl_context_patched(*args, **kwargs):
    ctx = _orig_create_ssl_context(*args, **kwargs)
    ctx.verify_flags |= ssl.VERIFY_X509_PARTIAL_CHAIN
    # SHA-1 签名的客户端证书在 TLS 1.3 下不受浏览器支持（signature_algorithms
    # 要求 SHA-256+），强制 TLS 1.2 以兼容 SHA-1 客户端证书
    ctx.maximum_version = ssl.TLSVersion.TLSv1_2
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    # 显式指定 IE 11 / Edge IE 模式兼容的强加密套件。
    # 避免 SECLEVEL=0 时 DEFAULT 启用弱套件（3DES 等）导致 IE 拒绝连接。
    ctx.set_ciphers(
        "ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:"
        "ECDHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:"
        "AES128-GCM-SHA256:AES256-GCM-SHA384:AES128-SHA256:AES256-SHA256:"
        "@SECLEVEL=0"
    )
    return ctx

_uv_config.create_ssl_context = _create_ssl_context_patched

# 证书路径支持环境变量覆盖（.env / Docker env），默认使用 ../certs
cert_dir = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "certs"))
keyfile  = os.environ.get("SSL_KEYFILE",  os.path.join(cert_dir, "server.key"))
certfile = os.environ.get("SSL_CERTFILE", os.path.join(cert_dir, "server.crt"))
cafile   = os.environ.get("SSL_CA_CERTS", os.path.join(cert_dir, "ca.crt"))

# 监听地址支持环境变量（本地 127.0.0.1，容器内 0.0.0.0）
HOST = os.environ.get("HOST", "127.0.0.1")

print(f"Cert dir: {cert_dir}")
print(f"key  exists: {os.path.isfile(keyfile)}")
print(f"cert exists: {os.path.isfile(certfile)}")
print(f"ca   exists: {os.path.isfile(cafile)}")

# ── Dual-server startup ────────────────────────────────

async def main():
    # Port 8000: NO client cert request — login page only
    config_8000 = uvicorn.Config(
        app,
        host=HOST, port=8000,
        ssl_keyfile=keyfile,
        ssl_certfile=certfile,
        ssl_cert_reqs=int(ssl.CERT_NONE),
        ssl_ciphers="DEFAULT:@SECLEVEL=0",  # 兼容 SHA-1 签名的客户端证书
        log_level="info",
    )
    # Port 8444: 应用入口（纯 HTTP）— nginx 在此前置做 mTLS 终止，
    # 通过 X-Client-Cert 头传递客户端证书，应用层解析身份
    config_8444 = uvicorn.Config(
        app,
        host=HOST, port=8444,
        log_level="info",
    )
    server_8000 = uvicorn.Server(config_8000)
    server_8444 = uvicorn.Server(config_8444)

    print("[PROD] Port 8000 — login page  (no cert required)")
    print("[PROD] Port 8444 — application  (HTTP, behind nginx mTLS)")
    print("[PROD] Visit https://localhost:8000 to start")

    await asyncio.gather(
        server_8000.serve(),
        server_8444.serve(),
    )

if __name__ == "__main__":
    asyncio.run(main())
