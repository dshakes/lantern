"""Deprecated shim: the ``lantern`` package is now ``pal`` (ADR 0032)."""

import importlib
import importlib.abc
import importlib.util
import sys
import warnings

from pal import *  # noqa: F403
from pal import __all__  # noqa: F401

warnings.warn("the `lantern` package is now `pal`; import from `pal`", DeprecationWarning, stacklevel=2)


class _AliasFinder(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    """Map ``lantern.<sub>`` to the real ``pal.<sub>`` module object (no double import)."""

    def find_spec(self, fullname, path=None, target=None):
        if fullname.startswith("lantern."):
            return importlib.util.spec_from_loader(fullname, self)
        return None

    def create_module(self, spec):
        return importlib.import_module("pal" + spec.name[len("lantern") :])

    def exec_module(self, module):
        pass


sys.meta_path.insert(0, _AliasFinder())
