from app.services.clerk_profile import _primary_email, _email_from_entry


def test_primary_email_prefers_primary_id() -> None:
    data = {
        "primary_email_address_id": "id_primary",
        "email_addresses": [
            {"id": "id_other", "email_address": "other@example.com"},
            {"id": "id_primary", "email_address": "primary@example.com"},
        ],
    }
    assert _primary_email(data) == "primary@example.com"


def test_primary_email_falls_back_to_first_address() -> None:
    data = {
        "email_addresses": [
            {"id": "id_one", "email_address": "first@example.com"},
            {"id": "id_two", "email_address": "second@example.com"},
        ],
    }
    assert _primary_email(data) == "first@example.com"


def test_email_from_entry_ignores_blank() -> None:
    assert _email_from_entry({"email_address": "  "}) is None
