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

from app.config import ALLOWED_CERT_SUBJECTS, SSL_CA_CERTS

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


def verify_client_cert_pem(pem: str) -> bool:
    """验证客户端证书 PEM 的签名（nginx X-Client-Cert 头来源）。

    信任模型：CA 级信任（信任列表中 RootCA/JSCA 签发的所有证书都认可）。
    - ``-partial_chain``：链中任一证书命中信任列表即通过
    - ``-no_check_time``：容忍中间 CA 已过期（JSCA 2024-08-20 到期）但叶子
      证书有效的场景
    - 叶子证书自身的有效期仍单独用 ``checkend`` 校验，过期的客户端证书拒绝
    """
    import subprocess
    import tempfile

    cert_path = None
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".pem", delete=False) as f:
            f.write(pem)
            cert_path = f.name
        r = subprocess.run(
            ["openssl", "verify", "-no_check_time", "-partial_chain", "-CAfile", SSL_CA_CERTS, cert_path],
            capture_output=True, timeout=10,
        )
        if r.returncode != 0:
            logger.warning(
                "X-Client-Cert signature verification failed: %s",
                r.stderr.decode("utf-8", errors="replace").strip()[:200],
            )
            return False
        # -no_check_time 不检查任何有效期：单独校验叶子证书是否已过期
        r2 = subprocess.run(
            ["openssl", "x509", "-in", cert_path, "-noout", "-checkend", "0"],
            capture_output=True, timeout=5,
        )
        if r2.returncode != 0:
            logger.warning(
                "X-Client-Cert leaf certificate expired: %s",
                r2.stderr.decode("utf-8", errors="replace").strip()[:200],
            )
            return False
        return True
    except Exception:
        logger.warning("Failed to verify client cert from header", exc_info=True)
        return False
    finally:
        if cert_path:
            try:
                os.unlink(cert_path)
            except OSError:
                pass


def _parse_cn_from_pem(pem: str) -> str | None:
    """解析已验证通过的客户端证书 PEM 中的 CN。"""
    import subprocess
    import tempfile

    cert_path = None
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".pem", delete=False) as f:
            f.write(pem)
            cert_path = f.name
        r = subprocess.run(
            ["openssl", "x509", "-in", cert_path, "-noout", "-subject"],
            capture_output=True, timeout=5,
        )
        out = r.stdout.decode("utf-8", errors="replace")
        m = re.search(r"CN\s*=\s*([^,\n]+)", out)
        return m.group(1).strip() if m else None
    except Exception:
        logger.warning("Failed to parse client cert CN from header", exc_info=True)
        return None
    finally:
        if cert_path:
            try:
                os.unlink(cert_path)
            except OSError:
                pass


def _get_cn_from_header_cert(request: Request) -> str | None:
    """从 nginx 传递的 X-Client-Cert 头获取已验证的客户端证书 CN。

    nginx 使用 ``ssl_verify_client optional_no_ca`` 请求但不验证客户端证书，
    将证书 PEM 通过 X-Client-Cert 头传递（$ssl_client_escaped_cert 为 URL
    转义格式，需先解码）。身份必须在后端核实：先验证签名再解析 CN，
    验证失败返回 None（不可信身份）。
    """
    from urllib.parse import unquote

    pem = unquote(request.headers.get("X-Client-Cert", ""))
    if not pem:
        return None
    if not verify_client_cert_pem(pem):
        return None
    return _parse_cn_from_pem(pem)


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
