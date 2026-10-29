"""Puts every skill's resources/ on sys.path, as the runner's PYTHONPATH does in the sandbox."""
import sys
from pathlib import Path

sys.path[:0] = map(str, sorted(Path(__file__).parent.glob("*/skills/*/resources")))
