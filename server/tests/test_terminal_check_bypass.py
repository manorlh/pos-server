

def test_the_unprinted_bon_alert_is_a_builtin_parameter_off_by_default():
    from app.services.till_parameters import BUILTIN_PARAMETERS

    spec = next(p for p in BUILTIN_PARAMETERS if p.key == "unprintedBonAlert")
    assert spec.value_type == "boolean" and spec.default_value is False
