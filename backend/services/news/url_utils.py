"""资讯地址的稳定规范化工具。"""

from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


_TRACKING_QUERY_KEYS = {
    "fbclid",
    "gclid",
    "mc_cid",
    "mc_eid",
    "ref_src",
}


def canonicalize_url(value: str | None) -> str | None:
    """移除片段和常见跟踪参数，保留可能决定内容身份的查询参数。"""
    if not value:
        return None
    try:
        parsed = urlsplit(value.strip())
        hostname = parsed.hostname
        port = parsed.port
    except ValueError:
        return None
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"} or not hostname:
        return None

    try:
        host = hostname.rstrip(".").encode("idna").decode("ascii").lower()
    except UnicodeError:
        return None
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    if port is not None and not (scheme == "http" and port == 80) and not (scheme == "https" and port == 443):
        host = f"{host}:{port}"

    path = parsed.path or "/"
    if path != "/":
        path = path.rstrip("/") or "/"
    query = urlencode(
        sorted(
            (key, item)
            for key, item in parse_qsl(parsed.query, keep_blank_values=True)
            if not key.lower().startswith("utm_") and key.lower() not in _TRACKING_QUERY_KEYS
        ),
        doseq=True,
    )
    return urlunsplit((scheme, host, path, query, ""))
