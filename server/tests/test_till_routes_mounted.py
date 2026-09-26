"""The routes a paired till calls are actually mounted.

Every other test here calls handler functions directly, which proves the handler works
and nothing about whether it is reachable. That gap shipped once: an edit removed the
`@router.get` decorator above `get_catalog_sync`, the function survived intact, every
test passed, and every till's catalog pull answered 405 in production. This asserts the
wiring itself, from the app a request would actually hit.
"""
from app.main import app

#: What the Android till (data/remote/PosApi.kt) and the desktop POS call, by method.
TILL_ROUTES = {
    ("GET", "/api/v1/sync/{machine_id}/catalog"),
    ("POST", "/api/v1/sync/{machine_id}/products"),
    ("PUT", "/api/v1/sync/{machine_id}/products/{product_id}"),
    ("DELETE", "/api/v1/sync/{machine_id}/products/{product_id}"),
    ("POST", "/api/v1/sync/{machine_id}/categories"),
    ("PUT", "/api/v1/sync/{machine_id}/categories/{category_id}"),
    ("DELETE", "/api/v1/sync/{machine_id}/categories/{category_id}"),
    ("PUT", "/api/v1/sync/{machine_id}/machine-catalog"),
    ("POST", "/api/v1/elevation/sessions"),
    ("DELETE", "/api/v1/elevation/sessions/current"),
}


def _mounted():
    return {
        (method, route.path)
        for route in app.routes
        for method in (getattr(route, "methods", None) or ())
    }


def test_every_route_the_till_calls_is_mounted():
    missing = TILL_ROUTES - _mounted()
    assert not missing, f"not mounted: {sorted(missing)}"


def test_the_catalog_pull_in_particular():
    # Named separately because it is the one every till calls on every wake-up.
    assert ("GET", "/api/v1/sync/{machine_id}/catalog") in _mounted()
