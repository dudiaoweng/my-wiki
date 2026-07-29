"""Production server entry point."""
import sys, os, ssl, asyncio, subprocess

os.chdir(os.path.dirname(os.path.abspath(__file__)))

# Kill any existing process on port 8000
if sys.platform == "win32":
    result = subprocess.run(
        ["cmd", "/c", "netstat -ano | findstr :8000 | findstr LISTENING"],
        capture_output=True, text=True,
    )
    for line in result.stdout.strip().split("\n"):
        parts = line.split()
        if parts:
            pid = parts[-1]
            subprocess.run(["cmd", "/c", f"taskkill /f /pid {pid}"],
                          capture_output=True)
            print(f"Killed stale process PID {pid}")

# Windows: fix SSL
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
print(f"[PROD] https://localhost:8000")

uvicorn.run(
    app,
    host="127.0.0.1",
    port=8000,
    ssl_keyfile=keyfile,
    ssl_certfile=certfile,
    ssl_ca_certs=cafile,
    ssl_cert_reqs=int(ssl.CERT_OPTIONAL),
    log_level="info",
)
