"""
Nothing leaves this process while the demo company is seeded.

The seeder drives the product's own routers, and some of them would wake devices or send
messages on the way: Ably notifies (catalog / settings / pos users / remote close), the
exception-alert SMS and web push, the club / 019 SMS queue, WhatsApp, Z-Credit's cloud
refunds, Cloudinary. Each is switched off here the way the product itself switches it off
(its env setting) and, on top, the network itself is closed: any socket that is not the
database on this machine raises `ExternalCallBlocked`, so a missed switch fails the run
instead of reaching a real service.

`environment()` must run before `app` is imported (the settings are read once);
`install()` after.
"""
from __future__ import annotations

import os
import socket
from typing import Dict, List

#: Every switch the product reads for an outbound service, set to "off" for this process.
#: pydantic-settings lets the process environment win over server/.env.
OFF: Dict[str, str] = {
    "ABLY_API_KEY": "",
    "CLOUDINARY_CLOUD_NAME": "",
    "CLOUDINARY_API_KEY": "",
    "CLOUDINARY_API_SECRET": "",
    "WEBPUSH_VAPID_PUBLIC_KEY": "",
    "WEBPUSH_VAPID_PRIVATE_KEY": "",
    "NOTIFICATIONS_LIVE_SENDING_ENABLED": "false",
    "NOTIFICATIONS_WORKER_ENABLED": "false",
    "EXCEPTION_ALERTS_SMS_PROVIDER": "dry_run",
    "EXCEPTION_ALERTS_WORKER_ENABLED": "false",
    "STOCK_RESET_WORKER_ENABLED": "false",
    "SALES_TARGETS_WORKER_ENABLED": "false",
    "WHATSAPP_CLOUD_API_ENABLED": "false",
    "WHATSAPP_WORKER_ENABLED": "false",
    "ZCREDIT_CLOUD_REFUNDS_ENABLED": "false",
    "PRODUCT_IMAGE_BG_REMOVAL": "false",
    # The request log would print every till payload of the month.
    "LOG_REQUEST_BODIES": "false",
    "LOG_LEVEL": "WARNING",
}

_LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost", "0.0.0.0"}


class ExternalCallBlocked(RuntimeError):
    pass


#: Every notify the product tried to send (event names only), for the run's report.
SUPPRESSED: List[str] = []


def environment() -> None:
    os.environ.update(OFF)


def _host_of(address) -> str:
    if isinstance(address, tuple) and address:
        return str(address[0])
    return str(address)


def _guard_sockets() -> None:
    real_connect = socket.socket.connect
    real_connect_ex = socket.socket.connect_ex
    real_create = socket.create_connection
    real_getaddrinfo = socket.getaddrinfo

    def _check(address) -> None:
        family_ok = True
        host = _host_of(address)
        if host not in _LOCAL_HOSTS and not host.startswith("127.") and family_ok:
            raise ExternalCallBlocked(f"outbound connection refused by the demo seeder: {host}")

    def connect(self, address):
        if self.family in (socket.AF_INET, socket.AF_INET6):
            _check(address)
        return real_connect(self, address)

    def connect_ex(self, address):
        if self.family in (socket.AF_INET, socket.AF_INET6):
            _check(address)
        return real_connect_ex(self, address)

    def create_connection(address, *a, **kw):
        _check(address)
        return real_create(address, *a, **kw)

    def getaddrinfo(host, *a, **kw):
        if host is not None and str(host) not in _LOCAL_HOSTS and not str(host).startswith("127."):
            raise ExternalCallBlocked(f"name lookup refused by the demo seeder: {host}")
        return real_getaddrinfo(host, *a, **kw)

    socket.socket.connect = connect
    socket.socket.connect_ex = connect_ex
    socket.create_connection = create_connection
    socket.getaddrinfo = getaddrinfo


def install() -> None:
    """After `app` is imported: the in-process switches, and the closed network."""
    from app.services import ably_notify
    from app.services.exception_alerts import push

    # Ably: no client at all (`publish_notify` then logs and returns); recorded for the report.
    ably_notify.settings.ably_api_key = ""
    ably_notify._ably_rest = None
    real_publish = ably_notify.publish_notify

    def publish_notify(tenant_id, machine_id, event, body):
        SUPPRESSED.append(str(event))
        return None

    ably_notify.publish_notify = publish_notify
    ably_notify._rest = lambda: None  # also the live-event push (report_events.live_push)
    assert real_publish is not None
    # Web push of exception alerts: not even queued to a thread.
    push.SEND_MODE = "off"
    _guard_sockets()
