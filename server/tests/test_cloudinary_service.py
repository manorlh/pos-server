import uuid
from unittest.mock import patch

import cloudinary.utils
import pytest
from fastapi import HTTPException

from app.services.cloudinary_service import build_upload_params, upload_folder


def test_upload_folder_scoped_by_tenant() -> None:
    tenant_id = uuid.uuid4()
    assert upload_folder(tenant_id, "products") == f"pos/{tenant_id}/products"
    assert upload_folder(tenant_id, "categories") == f"pos/{tenant_id}/categories"


def test_build_upload_params_generates_valid_signature() -> None:
    tenant_id = uuid.uuid4()
    secret = "test-secret"
    timestamp = 1_700_000_000

    class FakeSettings:
        cloudinary_cloud_name = "demo"
        cloudinary_api_key = "123456"
        cloudinary_api_secret = secret

    with patch("app.services.cloudinary_service.configure_cloudinary", return_value=FakeSettings()), patch(
        "app.services.cloudinary_service.time.time", return_value=timestamp
    ):
        params = build_upload_params(tenant_id, resource="products", settings=FakeSettings())

    assert params.cloud_name == "demo"
    assert params.api_key == "123456"
    assert params.timestamp == timestamp
    assert params.folder == f"pos/{tenant_id}/products"

    expected_sig = cloudinary.utils.api_sign_request(
        {"timestamp": timestamp, "folder": params.folder},
        secret,
    )
    assert params.signature == expected_sig


def test_build_upload_params_raises_when_not_configured() -> None:
    class EmptySettings:
        cloudinary_cloud_name = ""
        cloudinary_api_key = ""
        cloudinary_api_secret = ""

    with pytest.raises(HTTPException) as exc:
        build_upload_params(uuid.uuid4(), settings=EmptySettings())
    assert exc.value.status_code == 503
