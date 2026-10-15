"""Services. The notebook's guru modules live in backend/guru and are imported by their plain names."""
import sys

from ..config import BASE_DIR

_GURU = str(BASE_DIR / "guru")
if _GURU not in sys.path:
    sys.path.insert(0, _GURU)
