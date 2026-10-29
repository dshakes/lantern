import pytest

from lantern import _env


@pytest.mark.parametrize(
    ("env", "want"),
    [
        ({}, "dflt"),
        ({"LANTERN_API_URL": "l"}, "l"),
        ({"PAL_API_URL": "p"}, "p"),
        ({"PAL_API_URL": "p", "LANTERN_API_URL": "l"}, "p"),
        ({"PAL_API_URL": "", "LANTERN_API_URL": "l"}, "l"),
        ({"PAL_API_URL": "", "LANTERN_API_URL": ""}, ""),
        ({"PAL_API_URL": ""}, ""),
    ],
)
def test_get_prefers_pal(env: dict[str, str], want: str) -> None:
    assert _env.get("API_URL", "dflt", env=env) == want


def test_get_reads_process_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PAL_ENVTEST_X", raising=False)
    monkeypatch.setenv("LANTERN_ENVTEST_X", "legacy")
    assert _env.get("ENVTEST_X") == "legacy"
    monkeypatch.setenv("PAL_ENVTEST_X", "new")
    assert _env.get("ENVTEST_X") == "new"
