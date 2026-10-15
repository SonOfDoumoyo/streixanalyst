"""StreixAI chat (streamed with server-sent events)."""
import json
import secrets
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ..db import SessionLocal, get_db
from ..deps import current_user
from ..models import AnalysisLog, ChatMessage, User, iso, jdump, jload, utcnow
from ..plans import consume, require_feature, tier_of
from ..services import engine, streixai

router = APIRouter(prefix="/ai", tags=["streixai"])


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    thread_id: str | None = Field(None, max_length=40)
    symbol: str | None = Field(None, max_length=64)
    tf: str | None = Field(None, max_length=4)
    analysis_id: int | None = None


def _context(db, user, body):
    q = select(AnalysisLog).where(AnalysisLog.user_id == user.id, AnalysisLog.kind.in_(("analysis", "practice")),
                                  AnalysisLog.created_at >= utcnow() - timedelta(hours=12))
    if body.analysis_id:
        q = q.where(AnalysisLog.id == body.analysis_id)
    elif body.symbol:
        q = q.where(AnalysisLog.symbol == body.symbol.strip().upper())
        if body.tf:
            q = q.where(AnalysisLog.tf == body.tf)
    row = db.execute(q.order_by(AnalysisLog.id.desc()).limit(1)).scalar_one_or_none()
    return jload(row.summary, None) if row else None


def _sse(obj):
    return "data: " + json.dumps(obj, ensure_ascii=False) + "\n\n"


@router.post("/chat")
def chat(body: ChatIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    require_feature(user, "streixai")
    consume(db, user, "ai")
    tier = tier_of(user)
    thread = body.thread_id or secrets.token_urlsafe(12)
    hist = db.execute(select(ChatMessage).where(ChatMessage.user_id == user.id, ChatMessage.thread_id == thread)
                      .order_by(ChatMessage.id.desc()).limit(12)).scalars().all()[::-1]
    history = [dict(role=m.role, content=m.content) for m in hist]
    ctx = _context(db, user, body)
    detail = engine.BRAIN.get("detail")
    skill = (ctx or {}).get("model") or (detail.get("skill") if isinstance(detail, dict) else None)
    db.add(ChatMessage(user_id=user.id, thread_id=thread, role="user", content=body.message,
                       meta=jdump(dict(symbol=body.symbol, tf=body.tf))))
    db.commit()
    user_id = user.id

    def gen():
        parts, meta = [], {}
        yield _sse(dict(t="start", thread_id=thread, has_context=bool(ctx)))
        try:
            for kind, text in streixai.stream_answer(user, tier, history, body.message, ctx, skill):
                if kind == "meta":
                    meta = json.loads(text)
                    yield _sse(dict(t="meta", **meta))
                else:
                    parts.append(text)
                    yield _sse(dict(t="delta", v=text))
        except Exception as e:
            yield _sse(dict(t="error", v=f"StreixAI hit a problem: {type(e).__name__}. Please try again."))
        answer = "".join(parts).strip()
        if answer:
            s = SessionLocal()
            try:
                s.add(ChatMessage(user_id=user_id, thread_id=thread, role="assistant", content=answer,
                                  meta=jdump(meta)))
                s.commit()
            finally:
                s.close()
        yield _sse(dict(t="done", thread_id=thread))

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})


@router.get("/threads")
def threads(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.execute(select(ChatMessage.thread_id, func.min(ChatMessage.id), func.max(ChatMessage.created_at),
                             func.count(ChatMessage.id))
                      .where(ChatMessage.user_id == user.id).group_by(ChatMessage.thread_id)
                      .order_by(func.max(ChatMessage.created_at).desc()).limit(40)).all()
    out = []
    for tid, first_id, last, n in rows:
        first = db.get(ChatMessage, first_id)
        out.append(dict(thread_id=tid, title=(first.content[:70] if first else "Chat"), updated_at=iso(last),
                        messages=n))
    return dict(threads=out)


@router.get("/threads/{thread_id}")
def thread(thread_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.execute(select(ChatMessage).where(ChatMessage.user_id == user.id, ChatMessage.thread_id == thread_id)
                      .order_by(ChatMessage.id)).scalars().all()
    if not rows:
        raise HTTPException(404, "Conversation not found.")
    return dict(thread_id=thread_id, messages=[dict(role=m.role, content=m.content, created_at=iso(m.created_at))
                                               for m in rows])


@router.delete("/threads/{thread_id}")
def delete_thread(thread_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    db.execute(delete(ChatMessage).where(ChatMessage.user_id == user.id, ChatMessage.thread_id == thread_id))
    db.commit()
    return dict(ok=True)


@router.get("/suggestions")
def suggestions(user: User = Depends(current_user)):
    return dict(suggestions=streixai.SUGGESTIONS.get(user.experience or "beginner"), provider=streixai.provider())
