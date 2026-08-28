"""mTLS client certificate authentication.

Both development and production use the same mechanism:

  - uvicorn runs with SSL (ssl.CERT_OPTIONAL), allowing the initial page
    load without a client certificate.
  - Protected API endpoints return 401 when no valid client certificate is
    presented, which triggers the browser's native certificate-selection
    dialog.
  - Once a valid certificate is selected, the user is authenticated.
  - User identity is read from the certificate's Common Name (CN).
"""

import logging
import os
import re

from fastapi import HTTPException, Request, status
from pydantic import BaseModel

from app.config import ALLOWED_CERT_SUBJECTS

logger = logging.getLogger(__name__)

# CN format: "姓名 18位身份证号"  e.g. "谢林 320100198601010018"
_CN_RE = re.compile(r"^(.+?)\s+(\d{18})$")


def _parse_cn(cn: str) -> tuple[str, str]:
    """Extract (name, id_number) from a CN like ``谢林 320100198601010018``."""
    m = _CN_RE.match(cn.strip())
    if m:
        return m.group(1), m.group(2)
    return cn, ""


class CertInfo(BaseModel):
    authenticated: bool = False
    scheme: str = "https"
    display_name: str = ""
    name: str = ""
    id_number: str = ""


def _extract_cn_from_peercert(peercert: dict | None) -> str | None:
    """Extract the Common Name from an ssl peer certificate dict."""
    if not peercert:
        return None
    subject = peercert.get("subject", ())
    for field in subject:
        for key, value in field:
            if key == "commonName":
                return value
    return None


def _get_peercert(request: Request) -> dict | None:
    """Try every known way to extract the peer certificate from an ASGI request."""
    # Direct _transport on scope (injected by our monkey-patch in main.py)
    transport = request.scope.get("_transport")
    if transport is not None:
        cert = transport.get_extra_info("peercert")
        if cert:
            return cert

    # Nested under 'asgi' key
    asgi_scope = request.scope.get("asgi", {})
    if isinstance(asgi_scope, dict):
        t = asgi_scope.get("_transport")
        if t is not None:
            cert = t.get_extra_info("peercert")
            if cert:
                return cert

    # Scan for any transport-like object
    for key, val in request.scope.items():
        if hasattr(val, "get_extra_info"):
            cert = val.get_extra_info("peercert")
            if cert:
                logger.debug("Found transport at scope key: %s", key)
                return cert

    return None


def _get_cn_from_header_cert(request: Request) -> str | None:
    """从 nginx 传递的 X-Client-Cert 头解析客户端证书 CN。

    nginx 使用 ``ssl_verify_client optional_no_ca`` 请求但不验证客户端证书，
    将证书 PEM 通过 X-Client-Cert 头传递给后端。此处用 openssl 子进程解析 CN。
    nginx 的 $ssl_client_escaped_cert 是 URL 转义格式，需先解码。
    """
    pem = request.headers.get("X-Client-Cert", "")
    if not pem:
        return None
    from urllib.parse import unquote
    pem = unquote(pem)
    try:
        import subprocess
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".pem", delete=False) as f:
            f.write(pem)
            path = f.name
        try:
            r = subprocess.run(
                ["openssl", "x509", "-in", path, "-noout", "-subject"],
                capture_output=True, timeout=5,
            )
            out = r.stdout.decode("utf-8", errors="replace")
            m = re.search(r"CN\s*=\s*([^,\n]+)", out)
            return m.group(1).strip() if m else None
        finally:
            os.unlink(path)
    except Exception:
        logger.warning("Failed to parse client cert from header", exc_info=True)
        return None


def _make_cert_info(cn: str) -> CertInfo:
    """Build a CertInfo from a CN string, parsing out name / id_number."""
    name, id_number = _parse_cn(cn)
    return CertInfo(
        authenticated=True,
        scheme="https",
        display_name=cn,
        name=name,
        id_number=id_number,
    )


def _cn_allowed(cn: str | None) -> bool:
    """Check whether a certificate CN is in the configured allowlist.

    Returns True when no allowlist is configured (allow-all); otherwise the
    CN must match one of the ``ALLOWED_CERT_SUBJECTS`` DN strings.
    """
    if not ALLOWED_CERT_SUBJECTS:
        return True
    if not cn:
        return False
    for subject in ALLOWED_CERT_SUBJECTS:
        m = re.search(r"CN=([^/]+)", subject)
        if m and m.group(1).strip() == cn.strip():
            return True
    return False


# ── Dependencies ──────────────────────────────────────


async def verify_client_cert(request: Request) -> None:
    """FastAPI dependency — require a valid client certificate.

    Returns 401 if no certificate was presented (prompting the browser to
    re-negotiate the TLS connection), or if the certificate's CN is not in
    the ``ALLOWED_CERT_SUBJECTS`` allowlist.

    两种模式：
    - 直连模式：从 TLS 握手提取 peercert
    - nginx 反代模式：从 X-Client-Cert 头解析证书 CN
    """
    peercert = _get_peercert(request)
    if peercert:
        cn = _extract_cn_from_peercert(peercert)
        if cn and _cn_allowed(cn):
            return
        if cn and not _cn_allowed(cn):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Client certificate is not authorized",
            )

    # nginx 反向代理模式
    header_cn = _get_cn_from_header_cert(request)
    if header_cn:
        if _cn_allowed(header_cn):
            return
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Client certificate is not authorized",
        )

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Client certificate is required",
    )


async def get_client_cert(request: Request) -> CertInfo:
    """FastAPI dependency — return the current authentication state.

    Does NOT raise — returns ``authenticated=False`` when no certificate
    is present (or when its CN is missing / not in the allowlist), so the
    frontend can decide what to show.
    """
    peercert = _get_peercert(request)
    if peercert:
        cn = _extract_cn_from_peercert(peercert)
        if cn and _cn_allowed(cn):
            return _make_cert_info(cn)
        # Missing CN or not in allowlist → treat as unauthenticated.
        return CertInfo()

    # nginx 反向代理模式：从 X-Client-Cert 头解析身份
    header_cn = _get_cn_from_header_cert(request)
    if header_cn and _cn_allowed(header_cn):
        return _make_cert_info(header_cn)

    # No certificate presented yet
    return CertInfo()
