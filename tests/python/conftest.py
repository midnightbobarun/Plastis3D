"""Pytest fixtures for the Plastis3D Python half (Tier 1, PR1: health only).

Makes the repo root importable so tests can import ``plastis3d_scene`` and
the root ``__init__`` the same way Hermes does (the root package is loaded
with ``__path__`` set to the plugin directory).
"""

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


@pytest.fixture(autouse=True, scope="session")
def _isolated_data_dir(tmp_path_factory):
    """Never touch the real plugin-data folder.

    Several tests call the tools without a data-dir fixture of their own;
    before this guard each run left hundreds of ``analyze-N``, ``check-N``,
    ``tidy-N`` and ``weld-N`` scenes in ``~/.hermes/plugin-data/plastis3d``.
    The default for the whole session is a temporary folder. A test or
    fixture that sets ``PLASTIS3D_DATA_DIR`` itself simply overrides it.
    """
    import os

    previous = os.environ.get("PLASTIS3D_DATA_DIR")
    os.environ["PLASTIS3D_DATA_DIR"] = str(tmp_path_factory.mktemp("plastis3d-data"))
    yield
    if previous is None:
        os.environ.pop("PLASTIS3D_DATA_DIR", None)
    else:
        os.environ["PLASTIS3D_DATA_DIR"] = previous
