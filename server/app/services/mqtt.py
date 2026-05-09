"""
MQTT service — manages the broker connection and pub/sub logic.

Topics subscribed (POS → Server):
  pos/{merchant_id}/{machine_id}/sync/request      POS wake-up (server sends catalog/notify only)
  pos/{merchant_id}/{machine_id}/catalog/update    Deprecated: ignored (cloud is source of truth)
  pos/{merchant_id}/{machine_id}/heartbeat         POS online signal

Topics published (Server → POS):
  pos/{merchant_id}/{machine_id}/catalog/notify    lightweight: POS should GET /sync/.../catalog
  pos/{merchant_id}/{machine_id}/sync/ack            optional ACK for legacy clients
"""
import json
import logging
from datetime import datetime, timezone
from typing import Callable, List, Optional

import paho.mqtt.client as mqtt

from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()


class MQTTService:
    def __init__(self):
        self.client: Optional[mqtt.Client] = None
        self.connected = False
        self._message_callbacks: List[Callable] = []

    # ── Connection lifecycle ──────────────────────────────────────────────────

    def connect(self):
        if self.connected:
            return

        self.client = mqtt.Client(client_id=settings.mqtt_client_id)

        if settings.mqtt_broker_username:
            self.client.username_pw_set(
                settings.mqtt_broker_username,
                settings.mqtt_broker_password,
            )

        self.client.on_connect = self._on_connect
        self.client.on_message = self._on_message
        self.client.on_disconnect = self._on_disconnect

        try:
            self.client.connect(settings.mqtt_broker_host, settings.mqtt_broker_port, keepalive=60)
            self.client.loop_start()
            logger.info("Connected to MQTT broker at %s:%s", settings.mqtt_broker_host, settings.mqtt_broker_port)
        except Exception as exc:
            logger.error("Failed to connect to MQTT broker: %s", exc)
            raise

    def disconnect(self):
        if self.client:
            self.client.loop_stop()
            self.client.disconnect()
            self.connected = False
            logger.info("Disconnected from MQTT broker")

    # ── Internal callbacks ────────────────────────────────────────────────────

    def _on_connect(self, client, userdata, flags, rc):
        if rc == 0:
            self.connected = True
            logger.info("MQTT client connected")
            self._subscribe_all()
        else:
            logger.error("MQTT connect failed, rc=%s", rc)

    def _on_disconnect(self, client, userdata, rc):
        self.connected = False
        logger.info("MQTT client disconnected (rc=%s)", rc)

    def _on_message(self, client, userdata, msg):
        try:
            payload = json.loads(msg.payload.decode())
            logger.debug("MQTT ← %s", msg.topic)
            self._dispatch(msg.topic, payload)
            for cb in self._message_callbacks:
                cb(msg.topic, payload)
        except Exception as exc:
            logger.error("Error handling MQTT message on %s: %s", msg.topic, exc)

    # ── Subscriptions ─────────────────────────────────────────────────────────

    def _subscribe_all(self):
        topics = [
            "pos/+/+/sync/request",
            "pos/+/+/catalog/update",
            "pos/+/+/heartbeat",
        ]
        for topic in topics:
            self.client.subscribe(topic, qos=1)
            logger.info("Subscribed: %s", topic)

    # ── Inbound dispatch ──────────────────────────────────────────────────────

    def _dispatch(self, topic: str, payload: dict):
        """Route inbound POS messages to the correct handler."""
        parts = topic.split("/")
        if len(parts) < 4 or parts[0] != "pos":
            return

        _, merchant_id, machine_id, msg_type = parts[0], parts[1], parts[2], parts[3]

        if msg_type == "heartbeat":
            self._handle_heartbeat(machine_id)
            return
        if len(parts) < 5:
            return
        sub = parts[4]

        if msg_type == "sync" and sub == "request":
            self._handle_sync_request(merchant_id, machine_id, payload)
        elif msg_type == "catalog" and sub == "update":
            self._handle_catalog_update(merchant_id, machine_id, payload)

    def _handle_heartbeat(self, machine_id: str):
        from app.database import SessionLocal
        from app.services.sync import update_machine_heartbeat_timestamp

        db = SessionLocal()
        try:
            update_machine_heartbeat_timestamp(db, machine_id)
        finally:
            db.close()
        logger.debug("Heartbeat from machine %s", machine_id)

    def _handle_sync_request(self, merchant_id: str, machine_id: str, payload: dict):
        """POS asked to sync — tell it to pull catalog over HTTP (no payload on MQTT)."""
        from app.database import SessionLocal
        from app.services.sync import update_machine_sync_timestamp

        db = SessionLocal()
        try:
            update_machine_sync_timestamp(db, machine_id)
        finally:
            db.close()

        hint = "delta" if payload.get("lastSyncedAt") else "full"
        self.publish_catalog_notify(
            merchant_id,
            machine_id,
            reason="sync_request",
            hint=hint,
        )
        logger.info("Catalog notify sent to machine %s (hint=%s)", machine_id, hint)

    def _handle_catalog_update(self, merchant_id: str, machine_id: str, payload: dict):
        """POS → server catalog via MQTT is disabled; cloud is source of truth (use HTTP APIs)."""
        logger.info(
            "Ignoring catalog/update from machine %s (use cloud APIs first); topic merchant=%s",
            machine_id,
            merchant_id,
        )

    # ── Publish helpers ───────────────────────────────────────────────────────

    def _publish(self, topic: str, payload: dict, qos: int = 1):
        if not self.client or not self.connected:
            logger.warning("MQTT not connected, cannot publish to %s", topic)
            return
        try:
            result = self.client.publish(topic, json.dumps(payload, default=str), qos=qos)
            if result.rc != mqtt.MQTT_ERR_SUCCESS:
                logger.error("Publish failed on %s, rc=%s", topic, result.rc)
        except Exception as exc:
            logger.error("Error publishing to %s: %s", topic, exc)

    def publish_catalog_notify(
        self,
        merchant_id: str,
        machine_id: str,
        *,
        reason: str = "catalog_changed",
        hint: Optional[str] = None,
    ):
        """
        Lightweight signal for POS to call GET /sync/{machine_id}/catalog.
        """
        topic = f"pos/{merchant_id}/{machine_id}/catalog/notify"
        body = {
            "serverTime": datetime.now(timezone.utc).isoformat(),
            "reason": reason,
        }
        if hint:
            body["hint"] = hint
        self._publish(topic, body)

    def publish_pos_users_notify(
        self,
        merchant_id: str,
        machine_id: str,
        *,
        reason: str = "pos_users_changed",
        hint: Optional[str] = None,
    ):
        """
        Lightweight signal for POS to call GET /sync/{machine_id}/pos-users.
        Same body shape as catalog/notify so the POS handler is symmetrical.
        """
        topic = f"pos/{merchant_id}/{machine_id}/pos-users/notify"
        body = {
            "serverTime": datetime.now(timezone.utc).isoformat(),
            "reason": reason,
        }
        if hint:
            body["hint"] = hint
        self._publish(topic, body)

    def _publish_ack(self, merchant_id: str, machine_id: str, local_id: Optional[str] = None):
        topic = f"pos/{merchant_id}/{machine_id}/sync/ack"
        self._publish(topic, {
            "serverTime": datetime.now(timezone.utc).isoformat(),
            "localId": local_id,
        })

    def register_message_callback(self, callback: Callable):
        """Register additional callback for raw message handling."""
        self._message_callbacks.append(callback)


# Global singleton
mqtt_service = MQTTService()
