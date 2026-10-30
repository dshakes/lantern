"""Legacy ``lantern`` shim (ADR 0032): old imports keep working and resolve to ``pal`` objects."""

import importlib
import sys
import warnings

import pytest

import pal
import pal.client
import pal.errors


def _fresh_lantern():
    for m in [m for m in sys.modules if m == "lantern" or m.startswith("lantern.")]:
        del sys.modules[m]
    return importlib.import_module("lantern")


def test_import_warns_and_aliases_are_same_objects():
    with pytest.warns(DeprecationWarning, match="now `pal`"):
        lantern = _fresh_lantern()
    assert lantern.LanternClient is pal.PalClient
    assert lantern.LanternApiError is pal.PalApiError
    assert pal.LanternError is pal.PalError


def test_submodule_imports_map_to_pal_modules():
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        _fresh_lantern()
        import lantern.client as lc
        import lantern.runtime as rt
        from lantern.client import LanternClient
    assert LanternClient is pal.PalClient
    assert rt is pal.runtime
    assert lc is pal.client
    assert importlib.import_module("lantern.errors") is pal.errors


def test_deepagents_path_via_lantern():
    pytest.importorskip("deepagents")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        _fresh_lantern()
        from lantern.integrations.deepagents_sandbox import LanternSandbox
    from pal.integrations.deepagents_sandbox import PalSandbox

    assert LanternSandbox is PalSandbox
