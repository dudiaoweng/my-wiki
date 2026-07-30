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

cert_dir = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "certs"))
keyfile  = os.path.join(cert_dir, "server.key")
certfile = os.path.join(cert_dir, "server.crt")
cafile   = os.path.join(cert_dir, "ca.crt")

print(f"Cert dir: {cert_dir}")
print(f"key  exists: {os.path.isfile(keyfile)}")
print(f"cert exists: {os.path.isfile(certfile)}")
print(f"ca   exists: {os.path.isfile(cafile)}")

# ── Dual-server startup ────────────────────────────────

async def main():
    # Port 8000: NO client cert request — login page only
    config_8000 = uvicorn.Config(
        app,
        host="127.0.0.1", port=8000,
        ssl_keyfile=keyfile,
        ssl_certfile=certfile,
        ssl_cert_reqs=int(ssl.CERT_NONE),
        log_level="info",
    )
    # Port 8443: REQUIRED client cert — full application
    config_8443 = uvicorn.Config(
        app,
        host="127.0.0.1", port=8443,
        ssl_keyfile=keyfile,
        ssl_certfile=certfile,
        ssl_ca_certs=cafile,
        ssl_cert_reqs=int(ssl.CERT_REQUIRED),
        log_level="info",
    )

    server_8000 = uvicorn.Server(config_8000)
    server_8443 = uvicorn.Server(config_8443)

    print("[PROD] Port 8000 — login page  (no cert required)")
    print("[PROD] Port 8443 — application  (mTLS required)")
    print("[PROD] Visit https://localhost:8000 to start")

    await asyncio.gather(
        server_8000.serve(),
        server_8443.serve(),
    )

if __name__ == "__main__":
    asyncio.run(main())
