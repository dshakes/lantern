"""ADR 0026: egress credential-injection types serialize to the REST shape."""

from pal.types import CredentialInjection, EgressRule


def test_egress_rule_inject_serializes_camel_case() -> None:
    rule = EgressRule(
        pattern="api.openai.com",
        inject=[
            CredentialInjection(
                header="Authorization",
                secret_ref="lantern.secret/llm/openai",
                value_prefix="Bearer ",
            )
        ],
    )
    body = rule.model_dump(by_alias=True)
    assert body["inject"] == [
        {
            "header": "Authorization",
            "secretRef": "lantern.secret/llm/openai",
            "valuePrefix": "Bearer ",
        }
    ]
    assert body["httpMethods"] == [] and body["rateBps"] == 0


def test_egress_rule_parses_from_rest_shape() -> None:
    rule = EgressRule.model_validate(
        {"pattern": "x.com", "inject": [{"header": "x-api-key", "secretRef": "lantern.secret/llm/a"}]}
    )
    assert rule.inject[0].secret_ref == "lantern.secret/llm/a"
    assert rule.inject[0].value_prefix == ""
