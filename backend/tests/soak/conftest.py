import os
import sys
from pathlib import Path

os.environ.setdefault("LOOPKEEPER_LAYA_ROUTER", "0")        # keep the slow Laya router out of the fast-stepped loop (same as tests/conftest.py)
sys.path.insert(0, str(Path(__file__).parent))

import pytest  # noqa: E402


def pytest_configure(config):
    config.addinivalue_line("markers", "slow: long-running test (soak / chaos); each must stay under ~10 minutes")
