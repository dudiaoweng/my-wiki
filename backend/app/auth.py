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
    """
    peercert = _get_peercert(request)
    if not peercert:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Client certificate is required",
        )
    cn = _extract_cn_from_peercert(peercert)
    if not _cn_allowed(cn):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Client certificate is not authorized",
        )
    return


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

    # No certificate presented yet
    return CertInfo()
