"""StreixAI's built-in trading knowledge. Used when no AI provider is configured or reachable, and as quick
starter content. Each topic has a plain-language version and a deeper version for experienced traders."""
import re

TOPICS = [
    dict(id="start", title="How to start trading", keys=["start", "beginner", "new to trading", "how do i trade", "learn trading", "where do i begin", "first trade"],
         simple="Start slow and in this order: 1) learn to read a chart (candles, trend, support and resistance); 2) pick ONE market and ONE timeframe (e.g. BTCUSDT or EURUSD on 1h); 3) write down a simple plan: where you enter, where you're wrong (stop loss) and where you take profit; 4) practise on a demo account for at least 50 trades; 5) only then trade real money, risking 1% or less of your account per trade.\n\nIn StreixAnalyst: open the terminal, pick a pair, press **Analyse** and read the beginner report. Then try marking your own levels and ask me why the analyst agrees or not.",
         pro="A sustainable process: define the market and session you trade, the setups you take (with objective entry, invalidation and target rules), risk per trade (0.25–1%), and a journal with screenshots and R-multiples. Review weekly: expectancy = win% × avg win − loss% × avg loss. Scale size only after 100+ trades with positive expectancy."),
    dict(id="candles", title="Reading candlesticks", keys=["candle", "candlestick", "wick", "body", "doji", "engulfing", "pin bar", "hammer", "shooting star", "inside bar"],
         simple="Each candle shows four prices for its time period: open, high, low and close. Green (up) candles close higher than they opened; red (down) candles close lower. The thick part is the **body** (open→close); the thin lines are **wicks** (how far price went before being pushed back).\n\nLong wicks show rejection: a long lower wick means sellers pushed price down but buyers took it back. A big body with small wicks shows strong control by one side.",
         pro="Read candles in context, not alone: a bullish engulfing at a swept low into a discount zone means more than the same candle mid-range. Watch closes relative to levels (acceptance vs. rejection), wick-to-body ratios on liquidity sweeps, and displacement candles (range > 1.5–2 ATR) that leave fair value gaps."),
    dict(id="sr", title="Support and resistance", keys=["support", "resistance", "s/r", "level", "zone", "key level", "flip"],
         simple="**Support** is a price area where buyers have stepped in before, so falls often pause there. **Resistance** is an area where sellers stepped in, so rises often stall. Treat them as zones, not exact lines.\n\nWhen price breaks clearly through resistance and holds, that old resistance often becomes new support (a 'flip').",
         pro="Strength comes from: number of clean reactions, volume traded there (POC/HVN), higher-timeframe origin, and how decisively price left it. A level weakens with each test (orders get absorbed). In StreixAnalyst each level shows its historical hold/break counts and the model's probability of being reached within 24 candles."),
    dict(id="trend", title="Trends and market structure", keys=["trend", "structure", "higher high", "higher low", "lower high", "lower low", "hh", "hl", "lh", "ll", "uptrend", "downtrend"],
         simple="An **uptrend** makes higher highs (HH) and higher lows (HL), like stairs going up. A **downtrend** makes lower highs (LH) and lower lows (LL). If price stops making new highs and breaks the last higher low, the uptrend may be ending.\n\nThe simplest rule: trade in the direction of the trend on the higher timeframe.",
         pro="Define swings objectively (fractal pivots or ATR-based zigzag). Structure is timeframe-relative: a 15m downtrend can be a pullback inside a 4h uptrend. Align at least two timeframes (bias TF + execution TF) and expect counter-trend setups to have lower hit rates."),
    dict(id="bos", title="BOS and CHoCH", keys=["bos", "choch", "break of structure", "change of character", "mss", "market structure shift"],
         simple="A **BOS (break of structure)** is when price closes past the last swing in the trend's direction: the trend continues. A **CHoCH (change of character)** is the first break *against* the trend: an early warning the trend might turn.",
         pro="Require a candle close (not just a wick) for a valid break. A CHoCH that comes after a liquidity sweep and with displacement is higher quality (that's the sweep → MSS → FVG model). Internal vs. external structure matters: internal breaks inside a range are noise for the higher timeframe."),
    dict(id="liquidity", title="Liquidity and stop hunts", keys=["liquidity", "stop hunt", "sweep", "bsl", "ssl", "equal highs", "equal lows", "eqh", "eql", "inducement"],
         simple="Many traders put stop losses just above recent highs or just below recent lows. Those clusters of orders are called **liquidity**. Price often spikes through them (a 'sweep' or 'stop hunt') before turning. That's why stops placed exactly at an obvious high/low get hit so often.",
         pro="Buy-side liquidity (BSL) rests above swing highs/EQH, sell-side (SSL) below swing lows/EQL. Large players need that liquidity to fill size. Trade the reaction after the sweep (close back inside + structure shift), not the first touch. Place stops beyond the swept extreme with an ATR buffer."),
    dict(id="ob", title="Order blocks", keys=["order block", "ob", "breaker", "mitigation", "demand", "supply"],
         simple="An **order block** is the last opposite-colour candle before a strong move that broke structure. The idea: big orders were placed there, so price may react when it comes back. A bullish order block (last red candle before a big rally) can act as support.",
         pro="Validate OBs: the move away must break structure and ideally leave an FVG. Fresh (untested) OBs are stronger; each mitigation weakens them. When price closes through an OB it becomes a **breaker** and often flips role. Use the 50% (mean threshold) of the OB as a refined entry."),
    dict(id="fvg", title="Fair value gaps (FVG)", keys=["fvg", "fair value gap", "imbalance", "gap", "inefficiency"],
         simple="A **fair value gap** is a 3-candle pattern where the middle candle moves so fast that candle 1 and candle 3 don't overlap. That empty space is an 'imbalance', and price often comes back to fill part of it before continuing.",
         pro="Bullish FVG: low of candle 3 > high of candle 1. Quality depends on displacement size, location (discount for longs) and whether it formed during a structure break. Consequent encroachment (the 50% of the gap) is a common entry. Fully closed gaps lose relevance; inverted FVGs act as S/R."),
    dict(id="fib", title="Fibonacci and OTE", keys=["fib", "fibonacci", "ote", "optimal trade entry", "retracement", "0.618", "0.786", "golden pocket", "extension"],
         simple="Fibonacci retracements measure how far price pulls back after a move. Common levels are 50%, 61.8% and 78.6%. Pullbacks to 62–79% of a strong move (the **OTE zone**) are popular entry areas in a trend.",
         pro="Anchor on the impulse that broke structure (swing low → swing high for longs). OTE = 0.62–0.79 retracement; targets at −0.27/−0.62 extensions or the opposing liquidity. Fibs are only useful with confluence (OB/FVG inside OTE, discount of the dealing range)."),
    dict(id="pd", title="Premium and discount", keys=["premium", "discount", "equilibrium", "dealing range", "50%"],
         simple="Take the current range from the swing low to the swing high. The top half is **premium** (expensive), the bottom half is **discount** (cheap). Buy in discount, sell in premium — just like shopping.",
         pro="The dealing range is defined by the swings that produced the last structure break. Longs from discount with a target at the premium-side liquidity give natural R:R. Equilibrium (50%) is a magnet in ranges."),
    dict(id="risk", title="Risk management", keys=["risk", "risk management", "1%", "lose", "losing", "blow", "blew", "drawdown", "protect"],
         simple="The #1 rule: **never risk more than 1–2% of your account on one trade.** If you have $500 and risk 1%, you can lose $5 on that trade. That way even 10 losses in a row only cost about 10% and you stay in the game.\n\nAlways decide your stop loss *before* entering, and never move it further away.",
         pro="Size from the stop distance: units = (equity × risk%) / |entry − stop|. Cap daily loss (e.g. 3R) and weekly loss; reduce size in drawdowns. Correlated positions (e.g. EURUSD + GBPUSD longs) are effectively one bigger bet. Risk of ruin falls sharply below 1% per trade for strategies with modest edge."),
    dict(id="sizing", title="Position size", keys=["position size", "lot size", "lots", "how much", "units", "size my", "sizing"],
         simple="Work backwards from your stop:\n1) Decide how much money you can lose on this trade (e.g. 1% of $1,000 = $10).\n2) Measure the distance from entry to stop loss.\n3) Size = money at risk ÷ stop distance.\n\nExample: risk $10, entry 100, stop 98 → distance 2 → buy 5 units. StreixAnalyst's plan card does this for you.",
         pro="Forex: 1 standard lot = 100,000 units; pip value for xxxUSD pairs ≈ $10 per pip per lot. Gold: 1 lot = 100 oz on most brokers. Crypto: size in coins, then choose leverage only to fit margin — leverage doesn't change risk if size is fixed from the stop."),
    dict(id="leverage", title="Leverage and liquidation", keys=["leverage", "10x", "20x", "5x", "50x", "100x", "liquidation", "margin", "isolated", "cross"],
         simple="Leverage lets you open a position bigger than your money. 10x means $100 controls $1,000. It doesn't change how much you lose at your stop if you size correctly — but it puts your **liquidation price** closer. If price hits liquidation first, the exchange closes you and you lose the margin.\n\nBeginners: stay at **2x–5x** and always make sure liquidation is far beyond your stop loss.",
         pro="With isolated margin, liquidation ≈ entry × (1 − 1/L + MMR) for longs. Choose the lowest leverage that fits margin while keeping liquidation ≥ 1.5–2× the stop distance away. High leverage mostly increases fee/funding drag and liquidation risk on wicks. StreixAnalyst's plan shows the leverage band and liquidation price for your size."),
    dict(id="sl", title="Where to put a stop loss", keys=["stop loss", "stoploss", "sl", "stop", "invalidation", "stopped out"],
         simple="Put your stop where your idea is **proven wrong**, not at a random number. For a long, that's usually just below the swing low or zone you're buying from, plus a little extra room (so normal wicks don't hit it). Avoid putting it exactly on an obvious low — that's where stop hunts happen.",
         pro="Stop = structural invalidation + buffer (≈0.2–0.5 ATR beyond the swept extreme or zone). Stops tighter than ~0.5 ATR are mostly noise-driven. If the right stop makes R:R poor, skip the trade or wait for a better entry rather than tightening it."),
    dict(id="tp", title="Take profit and R:R", keys=["take profit", "tp", "target", "rr", "r:r", "reward", "risk reward", "risk to reward", "partial"],
         simple="Your take profit should be at a logical level where price may react: the next resistance (for longs), a previous high, or a liquidity pool. **R:R** (reward-to-risk) compares profit to risk: risking $10 to make $20 is 2R.\n\nA 2R target means you only need to win about 1 in 3 trades to break even (before fees).",
         pro="Break-even win rate = 1 / (1 + R) plus costs. Scale out: partial at TP1 (1–1.5R or first opposing level), runner to external liquidity. Don't set targets beyond a strong opposing HTF level; price must travel through it. StreixAnalyst shows P(TP before SL) next to the break-even rate for every target."),
    dict(id="expectancy", title="Win rate, expectancy and EV", keys=["win rate", "expectancy", "ev", "expected value", "edge", "probability", "profitable"],
         simple="A strategy is profitable when its wins pay for its losses. **Expectancy** = (win rate × average win) − (loss rate × average loss). Example: win 40% of trades at 2R and lose 60% at 1R → 0.4×2 − 0.6×1 = +0.2R per trade. Positive = good over many trades.",
         pro="Measure in R after costs (spread, fees, slippage, funding). Statistical confidence needs sample size: with 100 trades a +0.2R edge has a wide error bar. Out-of-sample tests and t-stats matter more than one great month. StreixAnalyst's model card reports its walk-forward results honestly — including when no edge is proven."),
    dict(id="psychology", title="Trading psychology", keys=["psychology", "emotion", "fear", "greed", "fomo", "revenge", "discipline", "tilt", "patience", "scared"],
         simple="Most losses come from behaviour, not analysis: chasing moves (FOMO), revenge trading after a loss, moving stops, or risking too much. Simple fixes: a written plan before each trade, a fixed risk per trade, a daily loss limit, and stepping away after 2–3 losses in a row.",
         pro="Process goals beat outcome goals. Pre-commit to rules (entry criteria, max trades/day, max daily loss) and journal emotional state per trade. Review losing streaks for rule breaks vs. normal variance. Reduce size after drawdowns to keep decision quality."),
    dict(id="timeframes", title="Timeframes and top-down analysis", keys=["timeframe", "top down", "top-down", "multi timeframe", "mtf", "htf", "ltf", "which timeframe", "1h", "4h", "daily", "15m", "1m", "scalp", "swing"],
         simple="Start high, then zoom in: check the **daily or 4h** to see the main trend and big levels, then use the **1h or 15m** to find your entry. Smaller timeframes (1m–5m) are fast and noisy; beginners usually do better on 1h–4h.",
         pro="Typical stacks: 1D→4h→15m (intraday swing), 4h→1h→5m, 1W→1D→4h (position). Bias from HTF structure/PD array, setup from mid TF, trigger from LTF (CHoCH + FVG). Costs matter more on low TFs: the same spread is a bigger fraction of a small stop."),
    dict(id="sessions", title="Sessions and killzones", keys=["session", "killzone", "london", "new york", "asia", "asian", "silver bullet", "open", "ny open"],
         simple="Forex and gold move most during the **London** (≈ 08:00–11:00 London time) and **New York** (≈ 08:00–11:00 New York time) sessions. The Asian session is usually quieter and often builds a range that London or New York breaks.",
         pro="ICT killzones (NY time): London 02:00–05:00, NY AM 07:00–10:00, silver bullets 03–04, 10–11, 14–15. Asian range highs/lows are common liquidity targets for London. Crypto trades 24/7 but volume still clusters around London/NY opens and US data releases."),
    dict(id="indicators", title="Indicators: EMA, RSI, VWAP", keys=["indicator", "ema", "moving average", "ma", "rsi", "vwap", "macd", "bollinger", "volume profile", "poc"],
         simple="Indicators summarise price; they don't predict it. **EMA** (moving average) smooths price to show the trend — price above a rising EMA 200 = generally bullish. **RSI** measures momentum from 0–100; above 70 is 'overbought', below 30 'oversold' (but strong trends stay overbought). **VWAP** is the average price weighted by volume for the day — a fair-value line intraday traders watch.",
         pro="Use them as context filters: EMA 50/200 slope for regime, RSI divergences at liquidity for exhaustion, anchored VWAP from key swings, volume profile POC/VAH/VAL for acceptance. Avoid stacking correlated oscillators."),
    dict(id="patterns", title="Chart patterns", keys=["pattern", "triangle", "wedge", "head and shoulders", "double top", "double bottom", "flag", "pennant", "channel", "cup"],
         simple="Patterns are common shapes price makes. **Double top** (two failed pushes at the same high) can signal a fall; **double bottom** the opposite. **Triangles** squeeze price until it breaks out. **Head and shoulders** often marks the end of an uptrend. Wait for the break (the 'trigger') before acting.",
         pro="Confirm with a close beyond the neckline/boundary and ideally a retest. Measured moves give rough targets but are unreliable alone. Many patterns are liquidity setups in disguise (e.g. a double top = equal highs that may get swept first)."),
    dict(id="divergence", title="RSI divergence", keys=["divergence", "hidden divergence", "regular divergence"],
         simple="A **divergence** is when price and RSI disagree: price makes a higher high but RSI makes a lower high. It suggests the move is losing strength. It's a warning, not a sell signal on its own.",
         pro="Regular divergences hint at reversal; hidden divergences (price HL, RSI LL) hint at continuation. They're most useful at HTF levels or after liquidity sweeps, confirmed by a structure shift."),
    dict(id="news", title="Trading the news", keys=["news", "nfp", "cpi", "fomc", "fed", "interest rate", "calendar", "economic", "release", "red folder", "high impact"],
         simple="Big economic releases (US jobs report/NFP, CPI inflation, central-bank rate decisions) can move markets violently in seconds. Spreads widen and stops can slip. If you're new, **avoid opening trades just before high-impact news** and consider closing or protecting open trades.\n\nStreixAnalyst checks the calendar every time you analyse and warns you when a release is close.",
         pro="Pre-release: liquidity thins, spreads widen; post-release: initial spike often reverses once positioning clears. Trade the reaction at levels after volatility normalises, or reduce size. Crypto reacts strongly to US CPI/FOMC too."),
    dict(id="crypto", title="Crypto: spot, futures and funding", keys=["crypto", "spot", "futures", "perpetual", "perp", "funding", "funding rate", "altcoin", "binance", "bybit", "memecoin", "usdt"],
         simple="**Spot** means you buy the actual coin. **Futures/perpetuals** are contracts that follow the price and allow leverage and shorting. Perps charge or pay a **funding fee** every few hours to keep their price close to spot. Small altcoins move much more than Bitcoin, so use smaller size on them.",
         pro="Funding > 0 means longs pay shorts (crowded longs); extreme funding + open-interest spikes often precede squeezes. Low-liquidity alts have big wicks and slippage: widen stops in ATR terms and cut size. Always check liquidation vs. stop with isolated margin."),
    dict(id="forex", title="Forex basics: pips, lots, spreads", keys=["forex", "fx", "pip", "pips", "lot", "spread", "currency", "eurusd", "gbpusd", "usdjpy", "broker"],
         simple="In forex you trade one currency against another (EUR/USD = euros priced in dollars). A **pip** is the 4th decimal for most pairs (0.0001) and the 2nd for JPY pairs (0.01). A **standard lot** is 100,000 units; 0.01 lots (a micro lot) is 1,000 units. The **spread** is the small difference between buy and sell price — your cost to enter.",
         pro="Pip value ≈ $10 per standard lot for xxxUSD pairs; convert for crosses. Swap (overnight financing) matters for multi-day holds. Majors have the tightest spreads during London/NY; exotics widen a lot."),
    dict(id="gold", title="Trading gold (XAUUSD)", keys=["gold", "xau", "xauusd"],
         simple="Gold moves a lot during the London and New York sessions and reacts strongly to US data and the dollar. It's volatile: a normal hourly move can be $5–15+. Use smaller size than you would on EUR/USD.",
         pro="1 lot = 100 oz on most brokers ($1 move = $100 per lot). Watch DXY and US real yields; FOMC/CPI drive the biggest moves. Asian range sweeps into London are a frequent pattern."),
    dict(id="journal", title="Keeping a trading journal", keys=["journal", "track", "record", "review my trades", "log"],
         simple="Write down every trade: date, pair, why you entered, entry, stop, target, result, and how you felt. Add a screenshot. Once a week, look for patterns: which setups win, which mistakes repeat.",
         pro="Track R-multiples, setup tags, session, HTF bias alignment, MAE/MFE, and rule adherence. Expectancy per setup tag tells you what to keep and what to drop."),
    dict(id="backtest", title="Backtesting and demo trading", keys=["backtest", "demo", "paper trade", "paper trading", "practice", "test my strategy"],
         simple="Before risking money, test your idea: scroll back on the chart and mark where your rules would have entered and exited (backtesting), then trade it live on a demo account (paper trading). If it doesn't work on demo, it won't work with real money.",
         pro="Avoid look-ahead and overfitting: fix rules before testing, use out-of-sample periods, include realistic costs and slippage, and measure t-stats over blocks of trades. In StreixAnalyst, the **Strategy lab** backtests your written rules this way (next-candle entries, stop-first on ambiguous candles, costs on every trade) and **Draw & score** trains your eye on live charts."),
    dict(id="app", title="Using StreixAnalyst", keys=["streixanalyst", "this app", "how does the app", "analyse button", "analyze button", "grade", "how to use", "features", "what can you do", "help"],
         simple="Here's how to get the most out of StreixAnalyst:\n• **Analyse**: pick a pair and timeframe, press Analyse — the analyst draws structure, levels, liquidity and a trade plan (entry, stop, targets) on the chart and writes a report.\n• **Grades** (A+ to D) score how many things line up; probabilities come from a model trained on years of data.\n• **Your drawings**: draw lines/zones and the analyst comments on them.\n• **Review**: enter your own trade idea and get it graded.\n• **News**: upcoming releases and headlines appear with every analysis.\n• **Draw & score**: mark your own levels and bias and get a score out of 100, with the levels you missed drawn on the chart.\n• **Strategy lab**: describe your rules in words and get an honest backtest plus a live signal check.\n• **Alerts** (the bell): price, plan and strategy alerts.\n• **Track record**: every trade call followed on live prices, losses included.\n• **Ask me** anything about the chart or trading.",
         pro="Detail levels (1–3) control how busy the overlay is. The plan card shows P(fill), P(TP before SL) per target vs. break-even, EV after costs, sizing, leverage band and liquidation. The model card (Pro report) shows out-of-sample skill and whether an edge is statistically proven."),
    dict(id="scam", title="Avoiding scams", keys=["scam", "signal group", "guaranteed", "double my money", "account manager", "recover", "pump"],
         simple="If someone promises guaranteed profits, asks you to send money to 'manage' for you, or sells 'sure signals', it's almost certainly a scam. No one can guarantee trading returns. Keep your funds on reputable, regulated platforms and never share passwords or 2FA codes.",
         pro="Red flags: fixed daily returns, pressure to deposit more to 'unlock' withdrawals, unregistered brokers, screenshots instead of verifiable track records. Verify licences (FCA, SEC, CySEC, SEC Nigeria) before using any broker."),
]

GREET = re.compile(r"^\s*(hi|hello|hey|yo|good (morning|afternoon|evening)|sup|hola)\b", re.I)
CHART_Q = re.compile(r"\b(this|the|current|my) (chart|setup|analysis|trade|plan|pair)\b|\b(why|should i|is it|entry|buy now|sell now|"
                     r"long or short|enter|explain (the|this)|what do you think|bias|grade)\b", re.I)


def _score(q, topic):
    ql = " " + q.lower() + " "
    s = 0
    for k in topic["keys"]:
        if len(k) <= 3:
            if re.search(r"(?<![a-z0-9])" + re.escape(k) + r"(?![a-z0-9])", ql):
                s += 2
        elif k in ql:
            s += 3 + len(k.split())
    if topic["title"].lower() in ql:
        s += 4
    return s


def best_topics(q, n=2):
    scored = sorted(((_score(q, t), t) for t in TOPICS), key=lambda x: -x[0])
    return [t for s, t in scored[:n] if s > 0]


def topic_list():
    return [dict(id=t["id"], title=t["title"]) for t in TOPICS]


def _fmt_p(x, dec):
    try:
        return f"{float(x):,.{int(dec)}f}"
    except (TypeError, ValueError):
        return "—"


def explain_analysis(ctx, experience):
    """Plain-language walk-through of the latest analysis (offline mode)."""
    a = ctx
    dec = a.get("decimals", 2)
    vd = a.get("verdict") or {}
    lines = [f"**{a.get('symbol')} · {a.get('tf')}** — price {_fmt_p(a.get('price'), dec)}", ""]
    lines.append(f"**Verdict:** {vd.get('headline', vd.get('action', '—'))}")
    tfs = a.get("timeframes") or []
    if tfs:
        lines.append("**Bigger picture:** " + "; ".join(f"{t.get('tf')} {t.get('trend_word', '')}".strip() for t in tfs[:3]))
    st = a.get("structure") or {}
    if st:
        trend = {1: "uptrend", -1: "downtrend", 0: "range"}.get(st.get("trend"), "unclear")
        phase = (st.get("phase") or {}).get("label")
        lines.append(f"**Structure:** {trend}" + (f", phase: {phase}" if phase else ""))
    pl = a.get("plan")
    if pl:
        tps = ", ".join(_fmt_p(t, dec) for t in pl.get("tps", []))
        lines += ["", f"**Plan ({pl.get('side')} {pl.get('type')}):** entry {_fmt_p(pl.get('entry'), dec)}, "
                      f"stop {_fmt_p(pl.get('sl'), dec)}, targets {tps}. Grade {pl.get('grade')}."]
        why = pl.get("why")
        if why:
            lines.append("**Why:** " + ("; ".join(str(w) for w in why[:4]) if isinstance(why, list) else str(why)))
        ptp = pl.get("p_tp") or []
        be = pl.get("breakeven") or []
        if ptp and be:
            lines.append(f"**Odds:** {100 * ptp[0]:.0f}% chance TP1 is hit before the stop vs {100 * be[0]:.0f}% needed to "
                         "break even.")
    nw = a.get("news") or {}
    if nw.get("note"):
        lines += ["", f"**News:** {nw['note']}"]
    if experience == "beginner":
        lines += ["", "_Tip: only take the plan if price reaches the entry, keep risk at 1% of your account, and never "
                      "move the stop further away._"]
    lines += ["", "Ask me about any part of it — e.g. *why is the stop there?* or *what is an order block?*"]
    return "\n".join(lines)


def focused_answer(q, ctx, experience):
    """Answers 'why is the stop/entry/target there', 'what leverage' from the analysis itself (offline mode)."""
    ql = q.lower()
    pl = (ctx or {}).get("plan")
    if not pl or not re.search(r"\b(this|that|my|here|there|should|plan|trade|why|where|which)\b", ql):
        return None                                        # a general question → the knowledge base answers it
    dec = ctx.get("decimals", 2)
    side = "long" if pl.get("side") == "long" else "short"
    beyond = "below" if side == "long" else "above"
    out = []
    if re.search(r"\b(stop|sl|stop loss|stop-loss|invalidat)", ql):
        out.append(f"**The stop at {_fmt_p(pl.get('sl'), dec)}** is where this {side} idea is proven wrong.")
        if pl.get("invalidation"):
            out.append(f"The setup is invalid if {pl['invalidation']}, so the stop sits just {beyond} that point with a small "
                       "buffer for normal wicks.")
        risk_atr = (ctx.get("plan") or {}).get("risk_atr") or None
        if risk_atr:
            out.append(f"It is about **{float(risk_atr):.1f} ATR** from the entry — wide enough to survive typical noise, tight "
                       "enough to keep the reward-to-risk sensible.")
        notes = [c["text"] for c in (pl.get("checklist") or [])
                 if ("liquidity" in c.get("text", "") or "sweep" in c.get("text", "")) and "target" not in c.get("text", "")]
        if notes:
            out.append("Liquidity check: " + "; ".join(notes[:2]) + ".")
        out.append("Never move a stop further away once you're in the trade; size the position so this stop costs about 1% "
                   "of your account.")
    elif re.search(r"\b(target|tp|take profit|take-profit)", ql):
        tps = pl.get("tps") or []
        labels = pl.get("tp_labels") or []
        out.append("**Targets** sit at the next levels where price is likely to react:")
        for i, t in enumerate(tps):
            lab = labels[i] if i < len(labels) else ""
            rr = (pl.get("rr") or [None] * 3)[i] if i < len(pl.get("rr") or []) else None
            out.append(f"- TP{i + 1} {_fmt_p(t, dec)}" + (f" — {lab}" if lab else "") + (f" ({float(rr):.1f}R)" if rr else ""))
        out.append("A common approach: take part of the position at TP1 and move the stop to break-even.")
    elif re.search(r"\b(entry|enter|buy now|sell now|why (buy|sell|long|short))", ql):
        out.append(f"**Entry {_fmt_p(pl.get('entry'), dec)}** ({pl.get('type')} order): {pl.get('setup', '')}.")
        why = pl.get("why") or []
        if why:
            out.append("What lines up there: " + "; ".join(str(w) for w in why[:4]) + ".")
    elif re.search(r"\b(leverage|liquidat|lot|size|how much)", ql):
        sz = pl.get("sizing") or {}
        if sz.get("leverage"):
            out.append(f"With {sz.get('risk_pct')}% risk on a ${sz.get('account')} account the plan suggests "
                       f"**{sz.get('leverage')}x** ({sz.get('mode', '')}).")
        if sz.get("liquidation"):
            out.append(f"Liquidation would be around {_fmt_p(sz.get('liquidation'), dec)} — beyond the stop, which is what "
                       "you want." if sz.get("liq_beyond_stop") else
                       f"Liquidation around {_fmt_p(sz.get('liquidation'), dec)} would come before the stop — use less "
                       "leverage.")
        if sz.get("max_safe_leverage"):
            out.append(f"Maximum sensible leverage for this stop distance: {sz['max_safe_leverage']}x. Beginners: stay at 2–5x.")
    if not out:
        return None
    return "\n\n".join(out[:1]) + ("\n" + "\n".join(out[1:]) if len(out) > 1 else "")


def practice_coach(ctx):
    pr = ctx["practice"]
    dec = ctx.get("decimals", 2)
    lines = [f"**You scored {pr['score']}/100 ({pr['grade']}) on {ctx.get('symbol')} {ctx.get('tf')}.**", ""]
    if pr.get("good"):
        lines.append("**What you did well**")
        lines += [f"- {g}" for g in pr["good"][:4]]
    if pr.get("improve"):
        lines += ["", "**What to work on**"]
        lines += [f"- {g}" for g in pr["improve"][:4]]
    missed = (pr.get("levels") or {}).get("missed") or []
    if missed:
        lines += ["", "**Levels you missed** (they're on your chart in orange):"]
        for m in missed[:4]:
            lines.append(f"- {_fmt_p(m.get('price'), dec)}: {' + '.join(m.get('labels', [])[:2])}")
    lines += ["", "_Drill for next time: before drawing anything, mark the last 3 swing highs and lows on the higher "
                  "timeframe, then only keep the levels where price reacted at least twice._"]
    return "\n".join(lines)


def offline_answer(question, experience="beginner", name=None, ctx=None):
    q = (question or "").strip()
    if GREET.match(q) and len(q) < 40:
        return (f"Hi{(' ' + name) if name else ''}! I'm **StreixAI**, your trading analyst. I can explain trading "
                "concepts (support/resistance, liquidity, order blocks, risk), walk you through the current chart "
                "analysis, or check a trade idea. What would you like to look at?")
    if ctx and ctx.get("practice") and re.search(r"coach|how did i|my score|miss|improve|practice|grade|score", q, re.I):
        return practice_coach(ctx)
    if ctx:
        f = focused_answer(q, ctx, experience)
        if f:
            return f
    if ctx and CHART_Q.search(q):
        return explain_analysis(ctx, experience)
    tops = best_topics(q)
    if not tops:
        if ctx:
            return explain_analysis(ctx, experience)
        titles = ", ".join(t["title"] for t in TOPICS[:12])
        return ("I'm in offline mode right now, so I answer from my built-in trading notes. I couldn't match that "
                f"question to a topic. Try asking about: {titles} — or press **Analyse** on a chart and ask me to "
                "explain it.")
    t = tops[0]
    body = t["simple"] if experience in (None, "beginner") else (t["pro"] if experience == "advanced" else
                                                                 t["simple"] + "\n\n**Going deeper:** " + t["pro"])
    out = f"### {t['title']}\n\n{body}"
    if len(tops) > 1:
        out += f"\n\nRelated: *{tops[1]['title']}* — ask me about it."
    return out
