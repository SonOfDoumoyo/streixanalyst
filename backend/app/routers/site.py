"""Public site details: contact information, the current Terms version and the trial length.

The web app reads this for the Contact and Terms pages, so contact details live in .env, not in the code."""
from fastapi import APIRouter

from ..config import settings

router = APIRouter(prefix="/site", tags=["site"])


@router.get("")
def site():
    return dict(
        product="StreixAnalyst", company="Streixcorp", version="1.3",
        terms_version=settings.terms_version, trial_days=settings.trial_days,
        contact={k: v for k, v in settings.contact.items() if v},   # only the details you have filled in
    )
