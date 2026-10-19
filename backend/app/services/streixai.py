"""StreixAI: the assistant. Streams answers from Claude (Anthropic API), Google Gemini or any OpenAI-compatible model,
with the user's current chart analysis as context. When one model fails before answering, the next one with a key is
tried; with none reachable, the built-in knowledge base answers."""
import json
import logging
import time
from datetime import datetime, timezone

import httpx

from ..config import settings
from . import knowledge

log = logging.getLogger("streix.ai")
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
_client = {"c": None}


def set_client(c):
    _client["c"] = c


def _http():
    if _client["c"] is None:
        _client["c"] = httpx.Client(timeout=httpx.Timeout(20.0, read=120.0))
    return _client["c"]


KEYS = {"anthropic": lambda: settings.anthropic_api_key, "gemini": lambda: settings.gemini_api_key,
        "openai": lambda: settings.openai_api_key}
ORDER = ("anthropic", "gemini", "openai")


def providers():
    """The cloud models to try, in order. AI_PROVIDER picks the first; the others with a key are the fallbacks, so one
    model being down (or out of credit) does not take StreixAI down with it."""
    p = settings.ai_provider
    if p == "offline":
        return []
    have = [x for x in ORDER if KEYS[x]()]
    if p in KEYS:
        return ([p] if p in have else []) + [x for x in have if x != p]
    return have


def provider():
    ps = providers()
    return ps[0] if ps else "offline"


def model_for(prov, tier):
    if prov == "anthropic":
        return settings.anthropic_model_fast if tier == "free" else settings.anthropic_model
    if prov == "gemini":
        return settings.gemini_model_fast if tier == "free" else settings.gemini_model
    return settings.openai_model


LEVEL_STYLE = {
    "beginner": "The user is a BEGINNER. Use plain words and short sentences, define every term the first time "
                "(e.g. 'liquidity — the stop orders sitting above old highs'), use simple analogies, give one clear "
                "next step, and keep numbers concrete. Avoid jargon walls.",
    "intermediate": "The user is INTERMEDIATE. Be practical: name the concept, explain the why, show how to apply "
                    "it on the chart, and point out common mistakes.",
    "advanced": "The user is ADVANCED. Be concise and technical (market structure, liquidity, ICT/SMC, order flow, "
                "statistics, expectancy). Skip basics unless asked; add nuance and edge cases.",
}


def system_prompt(user, tier, ctx=None, model_note=None):
    exp = user.experience or "beginner"
    today = datetime.now(timezone.utc).strftime("%A %d %B %Y, %H:%M UTC")
    parts = [
        "You are StreixAI, the trading analyst and coach inside StreixAnalyst (a charting and AI analysis platform by "
        "Streixcorp). You have deep knowledge of technical analysis (market structure, support/resistance, "
        "liquidity, order blocks, fair value gaps, Fibonacci/OTE, sessions, indicators, chart patterns), risk "
        "management, position sizing, leverage, crypto, forex, indices, commodities and stocks, and trading "
        "psychology. You teach as well as analyse.",
        f"Today is {today}. The user's name is {user.first_name or 'there'}.",
        LEVEL_STYLE.get(exp, LEVEL_STYLE["beginner"]),
        "Rules you always follow:\n"
        "- Be honest. Markets are uncertain; never promise profits or certainty. Probabilities from the app are "
        "calibrated estimates from history, not guarantees.\n"
        "- Use only the numbers in the CHART CONTEXT below for prices and levels. If there is no context or it lacks "
        "something, say so and suggest pressing Analyse — never invent prices, news or statistics.\n"
        "- Put risk first: suggest risking about 1% (max 2%) per trade, stops at the invalidation, liquidation far "
        "beyond the stop, low leverage (2–5x) for beginners. Warn about high-impact news when the context shows it.\n"
        "- When the user asks 'should I buy/sell', explain what the analysis says and the conditions, then remind "
        "them briefly that the decision and risk are theirs (one short line, not a lecture).\n"
        "- Refuse to help with scams, pump-and-dumps, market manipulation, or evading regulations.\n"
        "- Format with Markdown: short paragraphs, bullet points for steps, **bold** for key numbers. Keep answers "
        "focused (usually under 250 words unless the user asks for depth).\n"
        "- When the context has a 'learning' note, it is the analyst's own settled record: how calls like this one "
        "turned out, and how often its stops were swept (price ran the stop, then went to the target, the liquidity "
        "grab large players are often blamed for). Use it to discuss stop placement and position size honestly; a "
        "wider stop needs a smaller position for the same risk.",
        "App features you can point users to: the Analyse button (draws structure, levels, liquidity and a trade plan "
        "and writes a report), detail levels 1–3, drawing tools (trendlines, zones, fib, long/short position), trade "
        "review (grade your own entry/SL/TP), news & calendar inside each analysis, watchlist, TV mode for "
        "presenting, settings for candle colours, Draw & score (/practice: the user marks levels and a bias, the "
        "analyst scores it out of 100 and shows what was missed; daily challenge), the Strategy lab (/strategy: "
        "describe rules in plain words, get an honest backtest with costs and a live signal check), alerts (the bell: "
        "price, plan and strategy alerts) and the public Track record (/track-record: every trade call followed on "
        "live prices, losses included). Pro unlocks the strategy lab and higher limits.",
    ]
    if model_note:
        parts.append(model_note)
    if ctx and ctx.get("practice"):
        parts.append("PRACTICE MODE: the user drew their own analysis and it was scored against the analyst (see "
                     "'practice' in the context: score, what they did well, what to improve, the levels they missed). "
                     "Coach them: be encouraging and specific, explain each missed level and why it matters, and give "
                     "one concrete drill for next time.")
    if ctx:
        parts.append("CHART CONTEXT (the user's latest analysis, JSON):\n" + json.dumps(ctx, default=str)[:14000])
    else:
        parts.append("CHART CONTEXT: none yet (the user hasn't analysed a chart in this conversation).")
    if tier == "free":
        parts.append("The user is on the free plan; keep answers compact.")
    return "\n\n".join(parts)


def model_note_from(skill):
    if not skill:
        return None
    if not skill.get("trained"):
        return ("Model status: the probability model is not trained on this server yet, so probabilities are rough "
                "random-walk approximations. Say so if the user relies on them.")
    if skill.get("edge_proven"):
        return ("Model status: in out-of-sample tests the model's selected trades had a statistically significant "
                f"positive average result ({skill.get('model_avg_R')}R, t={skill.get('model_t')}), but past results "
                "don't guarantee future ones.")
    return ("Model status: the model's probabilities are well calibrated, but out-of-sample tests have NOT proven a "
            "trading edge after costs. Present grades as structured analysis and risk framing, not as a money "
            "machine, if the user asks how reliable it is.")


class ProviderError(Exception):
    pass


def _anthropic_stream(system, messages, model, max_tokens):
    body = dict(model=model, max_tokens=max_tokens, system=system, messages=messages, stream=True)
    headers = {"x-api-key": settings.anthropic_api_key, "anthropic-version": "2023-06-01",
               "content-type": "application/json"}
    with _http().stream("POST", ANTHROPIC_URL, headers=headers, json=body) as r:
        if r.status_code != 200:
            detail = r.read().decode("utf-8", "replace")[:300]
            raise ProviderError(f"Anthropic HTTP {r.status_code}: {detail}")
        for line in r.iter_lines():
            if not line or not line.startswith("data:"):
                continue
            try:
                data = json.loads(line[5:].strip())
            except ValueError:
                continue
            t = data.get("type")
            if t == "content_block_delta":
                delta = data.get("delta") or {}
                if delta.get("type") == "text_delta" and delta.get("text"):
                    yield delta["text"]
            elif t == "error":
                raise ProviderError(str(data.get("error"))[:300])
            elif t == "message_stop":
                break


def _openai_stream(system, messages, model, max_tokens):
    body = dict(model=model, max_tokens=max_tokens, stream=True,
                messages=[{"role": "system", "content": system}] + messages)
    headers = {"Authorization": f"Bearer {settings.openai_api_key}", "Content-Type": "application/json"}
    with _http().stream("POST", settings.openai_base_url + "/chat/completions", headers=headers, json=body) as r:
        if r.status_code != 200:
            detail = r.read().decode("utf-8", "replace")[:300]
            raise ProviderError(f"OpenAI-compatible HTTP {r.status_code}: {detail}")
        for line in r.iter_lines():
            if not line or not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                break
            try:
                data = json.loads(payload)
            except ValueError:
                continue
            for ch in data.get("choices") or []:
                txt = (ch.get("delta") or {}).get("content")
                if txt:
                    yield txt


def _gemini_stream(system, messages, model, max_tokens):
    """Google Gemini (generativelanguage API), streamed as server-sent events. Gemini calls the assistant 'model'."""
    body = dict(systemInstruction={"parts": [{"text": system}]},
                contents=[{"role": "model" if m["role"] == "assistant" else "user", "parts": [{"text": m["content"]}]}
                          for m in messages],
                generationConfig={"maxOutputTokens": max_tokens})
    headers = {"x-goog-api-key": settings.gemini_api_key, "Content-Type": "application/json"}
    url = f"{settings.gemini_base_url}/models/{model}:streamGenerateContent"
    with _http().stream("POST", url, params={"alt": "sse"}, headers=headers, json=body) as r:
        if r.status_code != 200:
            detail = r.read().decode("utf-8", "replace")[:300]
            raise ProviderError(f"Gemini HTTP {r.status_code}: {detail}")
        for line in r.iter_lines():
            if not line or not line.startswith("data:"):
                continue
            try:
                data = json.loads(line[5:].strip())
            except ValueError:
                continue
            if data.get("error"):
                raise ProviderError(str(data["error"])[:300])
            for cand in data.get("candidates") or []:
                for part in (cand.get("content") or {}).get("parts") or []:
                    if part.get("text") and not part.get("thought"):
                        yield part["text"]


STREAMS = {"anthropic": _anthropic_stream, "gemini": _gemini_stream, "openai": _openai_stream}


def complete(system, messages, tier="free", max_tokens=700):
    """A whole answer (not streamed) from the first model that gives one, or None when none can."""
    for prov in providers():
        try:
            out = "".join(STREAMS[prov](system, messages, model_for(prov, tier), max_tokens))
        except Exception as e:
            log.warning("AI provider %s failed: %s", prov, e)
            continue
        if out.strip():
            return out
    return None


def _chunks(text, size=24):
    words = text.split(" ")
    buf = []
    for w in words:
        buf.append(w)
        if sum(len(x) + 1 for x in buf) >= size:
            yield " ".join(buf) + " "
            buf = []
    if buf:
        yield " ".join(buf)


def stream_answer(user, tier, history, question, ctx=None, skill=None):
    """Yields (kind, text): kind is 'delta' for answer text, 'meta' once with the provider used."""
    msgs = [{"role": m["role"], "content": m["content"]} for m in history if m.get("content")]
    msgs.append({"role": "user", "content": question})
    # the API needs alternating roles starting with the user
    clean = []
    for m in msgs:
        if clean and clean[-1]["role"] == m["role"]:
            clean[-1]["content"] += "\n\n" + m["content"]
        else:
            clean.append(dict(m))
    while clean and clean[0]["role"] != "user":
        clean.pop(0)
    system = system_prompt(user, tier, ctx, model_note_from(skill))
    tried = providers()
    for prov in tried:
        model = model_for(prov, tier)
        got = False
        try:
            for piece in STREAMS[prov](system, clean, model, settings.ai_max_tokens):
                if not got:
                    yield "meta", json.dumps(dict(provider=prov, model=model))
                got = True
                yield "delta", piece
            if got:
                return
            raise ProviderError("empty response")
        except Exception as e:
            log.warning("AI provider %s failed: %s", prov, e)
            if got:
                yield "delta", "\n\n_(The connection to the model dropped. Ask again to continue.)_"
                return
            # nothing was sent yet: try the next model with a key
    if tried:
        yield "meta", json.dumps(dict(provider="offline", model="streixai-kb"))
        yield "delta", "_StreixAI's cloud models are unavailable right now, so here's my built-in answer._\n\n"
    else:
        yield "meta", json.dumps(dict(provider="offline", model="streixai-kb"))
    answer = knowledge.offline_answer(question, user.experience, user.first_name, ctx)
    for piece in _chunks(answer):
        yield "delta", piece
        time.sleep(0.012)


SUGGESTIONS = {
    "beginner": ["What is support and resistance?", "How much should I risk per trade?",
                 "Explain this chart's analysis simply", "What does 10x leverage mean?", "Where should my stop loss go?"],
    "intermediate": ["Why is the stop placed there?", "How do order blocks work?", "Is this a good time to trade "
                     "with the news?", "How do I size this trade?", "What makes this grade B instead of A?"],
    "advanced": ["Walk me through the HTF narrative", "Where's the liquidity draw?", "How reliable is the model's "
                 "edge?", "Best invalidation for this setup?", "Compare the primary and alternative plans"],
}
