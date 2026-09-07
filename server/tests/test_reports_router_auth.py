"""
Which token type can reach which report endpoint.

This is asserted rather than reviewed because the report endpoints split across two
audiences, and getting the split wrong is a privilege escalation rather than a bug:
`/reports/{machine_id}/shop-transactions` returns documents from *every* terminal in
a shop, so it is the one place a machine token reads beyond its own machine. Every
other report is dashboard-only, and `get_current_user` is what rejects a machine JWT.
"""
from __future__ import annotations

from app.main import app
from app.middleware.auth import (
    get_active_tenant_id,
    get_current_user,
    get_pos_machine_for_sync_path,
    get_pos_machine_from_machine_token,
)

_TRACKED = {
    get_current_user: "get_current_user",
    get_active_tenant_id: "get_active_tenant_id",
    get_pos_machine_for_sync_path: "get_pos_machine_for_sync_path",
    get_pos_machine_from_machine_token: "get_pos_machine_from_machine_token",
}


def _auth_dependencies(path: str) -> set[str]:
    """Names of the auth dependencies reachable from the route at `path`."""
    for route in app.routes:
        if getattr(route, "path", None) != path:
            continue
        found: set[str] = set()

        def walk(dependant) -> None:
            for sub in dependant.dependencies:
                if sub.call in _TRACKED:
                    found.add(_TRACKED[sub.call])
                walk(sub)

        walk(route.dependant)
        return found
    raise AssertionError(f"route not registered: {path}")


# ── Dashboard-only reports ───────────────────────────────────────────────────

def test_dashboard_reports_require_a_user_token_and_a_tenant() -> None:
    """
    `get_current_user` raises 401 on a machine JWT, and `get_active_tenant_id`
    requires an X-Tenant-Id the caller holds a membership for. A till cannot reach
    any of these.
    """
    for path in (
        "/api/v1/reports/products",
        "/api/v1/reports/cashiers",
        "/api/v1/reports/tips",
        # Reads across every till in a shop, so a machine token reaching it would see
        # the whole chain's takings from one paired terminal.
        "/api/v1/reports/day-summary",
        "/api/v1/z-reports",
    ):
        deps = _auth_dependencies(path)
        assert "get_current_user" in deps, path
        assert "get_active_tenant_id" in deps, path
        assert "get_pos_machine_for_sync_path" not in deps, path
        assert "get_pos_machine_from_machine_token" not in deps, path


# ── Till-facing shop feed ────────────────────────────────────────────────────

def test_shop_transactions_uses_the_same_dependency_as_sync_endpoints() -> None:
    deps = _auth_dependencies("/api/v1/reports/{machine_id}/shop-transactions")
    assert deps == {"get_pos_machine_for_sync_path"}


def test_shop_transactions_takes_no_scope_parameters_from_the_caller() -> None:
    """
    The whole scope comes from the authenticated machine row. If a shopId / tenantId
    / machineIds parameter ever appears here, a machine token starts being able to
    choose whose documents it reads.
    """
    schema = app.openapi()["paths"]["/api/v1/reports/{machine_id}/shop-transactions"]["get"]
    names = {p["name"] for p in schema.get("parameters", [])}
    assert names == {"machine_id", "hours", "q"}


def test_shop_transactions_response_matches_the_shipped_till_contract() -> None:
    """Field names and nullability are fixed by the Android ShopTransactionDto."""
    components = app.openapi()["components"]["schemas"]
    wrapper = components["ShopTransactionsResponse"]
    assert set(wrapper["properties"]) == {"serverTime", "transactions"}

    row = components["ShopTransactionRow"]["properties"]
    assert set(row) == {
        "id",
        "transactionNumber",
        "documentType",
        "total",
        "paymentMethod",
        "status",
        "cashierName",
        "machineName",
        "createdAt",
    }


def test_heartbeat_is_machine_token_only() -> None:
    deps = _auth_dependencies("/api/v1/machines/me/heartbeat")
    assert deps == {"get_pos_machine_from_machine_token"}


def test_day_summary_scope_parameters_are_narrowing_only() -> None:
    """
    `shopIds`/`machineIds` narrow a selection the user's role already permits — they
    are applied *after* `scope_query_by_user`, never instead of it. Asserted here
    because the failure mode is silent: a distributor passing another distributor's
    shop id would simply get that shop's takings.
    """
    schema = app.openapi()["paths"]["/api/v1/reports/day-summary"]["get"]
    names = {p["name"] for p in schema.get("parameters", [])}
    assert names == {"from", "to", "tz", "shopIds", "machineIds", "X-Tenant-Id"}
    # No tenantId parameter: the tenant comes from the header the caller is a member of.
    assert "tenantId" not in names
