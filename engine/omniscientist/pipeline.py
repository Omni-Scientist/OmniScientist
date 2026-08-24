"""mmsci -- the general end-to-end Multimodal AI Scientist engine.

Runs the 6-stage research loop with perception woven in, on ANY image-based discovery task:
  ideation -> novelty -> method -> experiment -> writeup -> review
The ON arm SEES the image at ideation/method/experiment; produces a FIGURE-RICH report (multimodal writeup);
a MULTIMODAL referee that also sees the image scores it. The OFF (text-blind) arm gets only a baseline of
NUMBERS (never the image) -- a fair "what a numbers-only scientist has" control. Two referees score both:
a text-blind one (controls for figure access) and the multimodal one (the one that reveals the gap).

GENERAL vs reproducible: the engine is domain-agnostic; everything task-specific lives in a CONFIG
(data, baseline-of-numbers, role, subject, ground truth, models). Run a bundled example config to reproduce
a demo; point --data at your own image to run your own task. See SKILL.md.

Usage:
  python pipeline.py --config examples/lens/config.yaml          # reproduce a bundled demo
  python pipeline.py --data my.png --baseline image_stats --role "a biologist" --subject "cell"
"""
import os, sys, json, base64, re, shutil, argparse, threading, time, hashlib
from types import SimpleNamespace
from openai import OpenAI

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Optional OpenAI-compatible gateway for models carried by neither OpenAI-official nor Anthropic-official.
# Bring your own endpoint: set OMNIST_GATEWAY_URL + OMNIST_GATEWAY_KEY. Absent -> None, and client_for raises a
# clear error only if a model actually routes here, so the engine imports fine with just OPENAI_API_KEY / ANTHROPIC_API_KEY.
_GATEWAY_URL = os.environ.get("OMNIST_GATEWAY_URL")
_GATEWAY_KEY = os.environ.get("OMNIST_GATEWAY_KEY")
client = (OpenAI(api_key=_GATEWAY_KEY, base_url=_GATEWAY_URL, timeout=120, max_retries=2)
          if (_GATEWAY_URL and _GATEWAY_KEY) else None)
# Frontier Claude (sonnet-5 / opus-5 / haiku-5 / fable-5 / mythos-5 / opus-4-8): route to Anthropic's OpenAI-compatible
# endpoint using ANTHROPIC_API_KEY. Every other model falls through to the optional gateway above.
_ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY")
_anthropic_client = (OpenAI(api_key=_ANTHROPIC_KEY, base_url="https://api.anthropic.com/v1/",
                            timeout=120, max_retries=2) if _ANTHROPIC_KEY else None)
# OpenAI OFFICIAL (api.openai.com) -> frontier GPT / o-series, with AUTOMATIC prompt caching: OpenAI caches a stable
# prefix >=1024 tokens server-side (no cache_control needed), billing the cached portion at a discount on every
# subsequent call. Routed here whenever OPENAI_API_KEY is set. This is the default backbone path.
_OPENAI_KEY = os.environ.get("OPENAI_API_KEY")
# reasoning models (gpt-5.x) run long on heavy multimodal context; 120s times out mid-agent-loop -> generous timeout
_openai_client = (OpenAI(api_key=_OPENAI_KEY, timeout=600, max_retries=2) if _OPENAI_KEY else None)
# LOCAL open-weight backbone (vLLM / sglang, reached via an OpenAI-compatible URL) -> set OMNIST_LOCAL_URL. Billed at
# $0 (your own GPU). Model name must start "local/" so client_for routes it here.
_LOCAL_URL = os.environ.get("OMNIST_LOCAL_URL")
_local_client = (OpenAI(api_key=os.environ.get("OMNIST_LOCAL_KEY", "EMPTY"), base_url=_LOCAL_URL,
                        timeout=600, max_retries=2) if _LOCAL_URL else None)
# OpenRouter aggregator: one key -> many frontier models. Model name must start "or/" so client_for routes here;
# create()/chat() strip the "or/" before sending. OpenAI-compatible.
_OPENROUTER_KEY = os.environ.get("OPENROUTER_API_KEY")
_openrouter_client = (OpenAI(api_key=_OPENROUTER_KEY, base_url="https://openrouter.ai/api/v1",
                             timeout=600, max_retries=2) if _OPENROUTER_KEY else None)
try:                                                     # native Anthropic SDK -> PROMPT CACHING (the OpenAI-compat
    import anthropic as _anthropic_sdk                   # endpoint above cannot cache); used only for the multi-step
    _anthropic_native = (_anthropic_sdk.Anthropic(api_key=_ANTHROPIC_KEY, timeout=120, max_retries=2)   # agent loop
                         if _ANTHROPIC_KEY else None)
except Exception:
    _anthropic_native = None


def _is_openai(model):
    return str(model).startswith(("gpt-", "o1", "o3", "o4", "chatgpt"))


def _is_reasoning(model):
    return str(model).startswith(("gpt-5", "o1", "o3", "o4"))   # reasoning models: reasoning tokens count toward completion


def client_for(model):
    """Transport for a model: Anthropic-direct for 5-gen Claude; OpenAI-official for GPT/o-series (the default path,
    with OpenAI's automatic prompt caching); the optional OpenAI-compatible gateway for everything else."""
    if str(model).startswith("local/") and _local_client is not None:
        return _local_client
    if str(model).startswith("or/") and _openrouter_client is not None:
        return _openrouter_client
    if str(model).startswith(("claude-sonnet-5", "claude-opus-5", "claude-opus-4-8", "claude-haiku-5", "claude-fable-5", "claude-mythos-5", "claude-5")):
        if _anthropic_client is None:
            raise RuntimeError("model %r needs ANTHROPIC_API_KEY in the environment (not set)" % model)
        return _anthropic_client
    if _is_openai(model) and _openai_client is not None:
        return _openai_client
    if client is None:
        raise RuntimeError(
            "no transport configured for model %r: set OPENAI_API_KEY (GPT / o-series), "
            "ANTHROPIC_API_KEY (Claude 5-gen), or OMNIST_GATEWAY_URL + OMNIST_GATEWAY_KEY (OpenAI-compatible gateway)" % model)
    return client


def _is_5gen(model):
    return str(model).startswith(("claude-sonnet-5", "claude-opus-5", "claude-opus-4-8", "claude-haiku-5", "claude-fable-5", "claude-mythos-5", "claude-5"))


def _to_anthropic(messages, tools):
    """OpenAI-format (system / user / assistant+tool_calls / tool) -> native Anthropic (system, messages, tools),
    coalescing consecutive same-role turns (Anthropic needs strict user/assistant alternation) and placing <=4
    ephemeral cache_control breakpoints on the STABLE prefix (system, tools, last turn) so every step after the
    first bills that prefix at ~1/10. Text-only: the agent loop never carries image blocks (vision -> chat())."""
    system_text, conv = None, []

    def push(role, blocks):
        if not blocks:
            return
        if conv and conv[-1]["role"] == role:
            conv[-1]["content"].extend(blocks)
        else:
            conv.append({"role": role, "content": blocks})

    for m in messages:
        role, c = m.get("role"), m.get("content")
        if role == "system":
            system_text = c if isinstance(c, str) else " ".join(p.get("text", "") for p in (c or []) if isinstance(p, dict))
        elif role == "tool":
            push("user", [{"type": "tool_result", "tool_use_id": m.get("tool_call_id"), "content": (c or "(empty)")}])
        elif role == "assistant":
            blocks = []
            if isinstance(c, str) and c.strip():
                blocks.append({"type": "text", "text": c})
            for tc in (m.get("tool_calls") or []):
                fn = tc.get("function", {})
                try:
                    inp = json.loads(fn.get("arguments") or "{}")
                except Exception:
                    inp = {}
                if not isinstance(inp, dict):            # Anthropic tool_use.input must be an object
                    inp = {}
                blocks.append({"type": "tool_use", "id": tc.get("id"), "name": fn.get("name"), "input": inp})
            push("assistant", blocks)
        else:                                            # user
            txt = c if isinstance(c, str) else " ".join(p.get("text", "") for p in (c or []) if isinstance(p, dict) and p.get("type") == "text")
            push("user", [{"type": "text", "text": txt or "(empty)"}])

    atools = [{"name": (t.get("function") or {}).get("name"),
               "description": (t.get("function") or {}).get("description", ""),
               "input_schema": (t.get("function") or {}).get("parameters") or {"type": "object", "properties": {}}}
              for t in (tools or [])]
    sys_param = [{"type": "text", "text": system_text, "cache_control": {"type": "ephemeral"}}] if system_text else None
    if atools:
        atools[-1] = {**atools[-1], "cache_control": {"type": "ephemeral"}}
    if conv and conv[-1]["content"]:                     # cache the growing conversation prefix incrementally
        conv[-1]["content"][-1] = {**conv[-1]["content"][-1], "cache_control": {"type": "ephemeral"}}
    return sys_param, conv, atools


def _from_anthropic(r):
    """Native Anthropic response -> an OpenAI-shaped object so every caller (agent_loop, chat) stays unchanged."""
    text, tool_calls = [], []
    for b in r.content:
        if b.type == "text":
            text.append(b.text)
        elif b.type == "tool_use":
            tool_calls.append(SimpleNamespace(id=b.id, type="function",
                                              function=SimpleNamespace(name=b.name, arguments=json.dumps(b.input or {}))))
    u = r.usage
    usage = SimpleNamespace(prompt_tokens=getattr(u, "input_tokens", 0) or 0,          # FRESH (uncached) input only
                            completion_tokens=getattr(u, "output_tokens", 0) or 0,
                            cache_read_input_tokens=getattr(u, "cache_read_input_tokens", 0) or 0,
                            cache_creation_input_tokens=getattr(u, "cache_creation_input_tokens", 0) or 0)
    msg = SimpleNamespace(content=("\n".join(text) or None), tool_calls=(tool_calls or None))
    return SimpleNamespace(choices=[SimpleNamespace(message=msg)], usage=usage)


def _responses_user_content(c):
    """OpenAI-chat user content -> /v1/responses user content.

    Keeps IMAGES. The chat format carries them as {"type":"image_url","image_url":{"url": ...}}; the responses
    API wants {"type":"input_image","image_url": <url string>} and calls text "input_text". Dropping the image
    blocks here does not raise: the model simply answers a picture question having seen no picture, and the
    perception observation that comes back is invented. Text-only content stays a bare string so the
    prompt_cache_key anchor below keeps working unchanged."""
    if isinstance(c, str):
        return c or "(empty)"
    parts = [p for p in (c or []) if isinstance(p, dict)]
    if not any(p.get("type") == "image_url" for p in parts):
        return " ".join(p.get("text", "") for p in parts if p.get("type") == "text") or "(empty)"
    out = []
    for p in parts:
        if p.get("type") == "text":
            out.append({"type": "input_text", "text": p.get("text", "")})
        elif p.get("type") == "image_url":
            iu = p.get("image_url") or {}
            url = iu.get("url") if isinstance(iu, dict) else iu
            if not url:
                raise ValueError("image_url block carries no url: %r" % (p,))
            block = {"type": "input_image", "image_url": url}
            detail = iu.get("detail") if isinstance(iu, dict) else None
            if detail:
                block["detail"] = detail
            out.append(block)
    return out


def _to_responses(messages, tools):
    """OpenAI-chat-format (system/user/assistant+tool_calls/tool) -> OpenAI /v1/responses (instructions + input items +
    FLAT tools). gpt-5.6 rejects function tools together with reasoning_effort in chat.completions; the responses API
    keeps BOTH (real reasoning + tool calling), so we route gpt-5.6 here and adapt the shapes."""
    instructions, inp = None, []
    for m in messages:
        role, c = m.get("role"), m.get("content")
        if role == "system":
            instructions = c if isinstance(c, str) else " ".join(p.get("text", "") for p in (c or []) if isinstance(p, dict))
        elif role == "tool":                                  # tool result -> function_call_output (matched by call_id)
            inp.append({"type": "function_call_output", "call_id": m.get("tool_call_id"), "output": str(c if c is not None else "(empty)")})
        elif role == "assistant":
            if isinstance(c, str) and c.strip():
                inp.append({"role": "assistant", "content": c})
            for tc in (m.get("tool_calls") or []):            # assistant tool call -> function_call item
                fn = tc.get("function", {})
                inp.append({"type": "function_call", "call_id": tc.get("id"), "name": fn.get("name"), "arguments": fn.get("arguments") or "{}"})
        else:                                                 # user
            inp.append({"role": "user", "content": _responses_user_content(c)})
    rtools = [{"type": "function", "name": (t.get("function") or {}).get("name"),
               "description": (t.get("function") or {}).get("description", ""),
               "parameters": (t.get("function") or {}).get("parameters") or {"type": "object", "properties": {}}}
              for t in (tools or [])]
    return instructions, inp, rtools


def _from_responses(r):
    """OpenAI /v1/responses object -> an OpenAI-chat-shaped object so agent_loop/chat stay unchanged (mirrors _from_anthropic)."""
    text, tool_calls = [], []
    for o in (r.output or []):
        t = getattr(o, "type", None)
        if t == "function_call":
            tool_calls.append(SimpleNamespace(id=getattr(o, "call_id", None), type="function",
                                              function=SimpleNamespace(name=o.name, arguments=o.arguments or "{}")))
        elif t == "message":
            for part in (getattr(o, "content", None) or []):
                if getattr(part, "type", None) in ("output_text", "text"):
                    text.append(getattr(part, "text", "") or "")
    u = getattr(r, "usage", None)
    cached = getattr(getattr(u, "input_tokens_details", None), "cached_tokens", 0) or 0
    usage = SimpleNamespace(prompt_tokens=getattr(u, "input_tokens", 0) or 0,
                            completion_tokens=getattr(u, "output_tokens", 0) or 0,
                            prompt_tokens_details=SimpleNamespace(cached_tokens=cached))
    msg = SimpleNamespace(content=("\n".join(text) or None), tool_calls=(tool_calls or None))
    return SimpleNamespace(choices=[SimpleNamespace(message=msg)], usage=usage)


# Per-model minimum interval between API calls (seconds). Dense back-to-back calls (stage-3's 20+ writing paragraphs)
# rate-limit some OpenRouter providers -> empty returns; a small gap fixes it. Default: NONE (other models untouched).
#   env OMNIST_MODEL_INTERVAL="or/minimax/minimax-m3:0.5,or/z-ai/glm-5.2:0.3"
_MODEL_INTERVAL = {}
for _kv in (os.environ.get("OMNIST_MODEL_INTERVAL") or "").split(","):
    _kv = _kv.strip()
    if ":" in _kv:
        _mn, _, _sec = _kv.rpartition(":")
        try:
            _MODEL_INTERVAL[_mn.strip()] = float(_sec)
        except ValueError:
            pass
_last_call_ts = {}


def _throttle(model):
    iv = _MODEL_INTERVAL.get(model, 0.0)
    if iv <= 0:
        return
    import time
    gap = time.time() - _last_call_ts.get(model, 0.0)
    if gap < iv:
        time.sleep(iv - gap)
    _last_call_ts[model] = time.time()


# 模型名前缀（"local/"、"or/"）只是 client_for() 的选路标记，服务端一概不认：
# OpenRouter 要 bare vendor/id，Ollama / vLLM / sglang 只认裸模型名，带前缀会 404 model not found。
# 路由和剥离共用下面这张表，加新后端只改一处，不会出现"路由认得、剥离忘了"的偏差；
# 用 removeprefix 而不是写死切片长度，省得数错一位悄悄发出半截模型名。
_ROUTE_PREFIX = (("or/", lambda: _openrouter_client), ("local/", lambda: _local_client))


def _bare_model(model, cl):
    """把路由前缀剥掉。只在该前缀确实把请求路由到了对应客户端时才剥，避免误伤同名模型。"""
    name = str(model)
    for prefix, owner in _ROUTE_PREFIX:
        if cl is owner() and name.startswith(prefix):
            bare = name.removeprefix(prefix)
            if not bare:
                # 只写了前缀没写模型名。不拦的话会把空串发出去，服务端回一句
                # "model '' not found"，没人能从那句话猜到是自己少填了模型名。
                raise RuntimeError(
                    "model %r only has the %r routing prefix and no model name after it; "
                    "write it as %s<model>, e.g. %sqwen3:8b" % (model, prefix, prefix, prefix))
            return bare
    return model


def create(model, messages, max_tokens=700, temperature=0.0, seed=None, tools=None, tool_choice="auto", cache=False):
    """One entry point for chat/tool calls. For the multi-step agent loop (cache=True) on a 5-gen Claude model we
    use the NATIVE Anthropic SDK with PROMPT CACHING (the OpenAI-compat endpoint cannot cache); the stable prefix
    (system + tools + prior turns) is then billed at ~1/10 on every step after the first. Everything else keeps the
    OpenAI-format path: the gateway passes temperature/seed for determinism; Anthropic 5-gen omits them."""
    _throttle(model)                                    # per-model rate-limit gap (default none; e.g. minimax on OpenRouter)
    if cache and _anthropic_native is not None and _is_5gen(model):
        sys_param, conv, atools = _to_anthropic(messages, tools)
        kw = {"model": model, "max_tokens": max_tokens, "messages": conv}
        if sys_param is not None:
            kw["system"] = sys_param
        if atools:
            kw["tools"] = atools
            kw["tool_choice"] = {"type": "auto"}
        return _from_anthropic(_anthropic_native.messages.create(**kw))
    cl = client_for(model)
    send_model = _bare_model(model, cl)
    kw = {"model": send_model, "messages": messages}
    if cl is _openai_client:                            # OpenAI's newer models (gpt-5.x / o-series) use max_completion_tokens
        if str(model).startswith("gpt-5.6"):
            # gpt-5.6 FORBIDS function tools together with reasoning_effort in chat.completions. Route it to /v1/responses,
            # which keeps BOTH real reasoning and tool calls, and still gets OpenAI prefix caching via prompt_cache_key.
            instructions, inp, rtools = _to_responses(messages, tools)
            rkw = {"model": model, "input": inp, "max_output_tokens": max_tokens + 2000, "reasoning": {"effort": "low"}}
            if instructions:
                rkw["instructions"] = instructions
            if rtools:
                rkw["tools"] = rtools; rkw["tool_choice"] = "auto"
            _a = instructions or (inp[0].get("content") if inp and isinstance(inp[0].get("content"), str) else "")
            if _a:
                rkw["prompt_cache_key"] = "omnist-" + hashlib.md5(_a[:400].encode()).hexdigest()[:16]
            return _from_responses(_openai_client.responses.create(**rkw))
        if _is_reasoning(model):
            # reasoning tokens are billed as completion and drawn from this budget FIRST; a small cap (e.g. a 140-token
            # title) is entirely consumed by reasoning -> empty output, so reserve headroom.
            kw["max_completion_tokens"] = max_tokens + 1500
            # 'reasoning_effort' + function tools is REJECTED on /v1/chat/completions (needs /v1/responses); so cap the
            # effort only on tool-FREE calls (the stage-3 writer/title). Tool calls (the agent loop) use default reasoning.
            if tools is None:
                kw["reasoning_effort"] = "low"          # 'minimal' unsupported on gpt-5.5
        else:
            kw["max_completion_tokens"] = max_tokens
        # a stable prompt_cache_key routes repeated same-prefix calls (the agent loop reuses ONE system prompt across
        # every step) to the same cache backend, so OpenAI's automatic prefix caching hits reliably, not best-effort.
        anchor = ""
        for _m in messages:
            if _m.get("role") in ("system", "user"):
                _c = _m.get("content")
                anchor = _c if isinstance(_c, str) else next(
                    (p.get("text", "") for p in (_c or []) if isinstance(p, dict) and p.get("type") == "text"), "")
                if anchor:
                    break
        if anchor:
            kw["extra_body"] = {"prompt_cache_key": "omnist-" + hashlib.md5(anchor[:400].encode()).hexdigest()[:16]}
    else:
        kw["max_tokens"] = max_tokens
        if cl is _local_client and os.environ.get("OMNIST_LOCAL_NOTHINK"):
            # Qwen3.5 is a thinking model that spends the WHOLE budget on <think> and returns EMPTY content (out=0c) on
            # short WRITING calls. Disabling thinking fixes that (verified content 0 -> 1074, tool-calling still works).
            # BUT thinking HELPS ideation/experiment reasoning, so this is GATED by env: only stage 3 (writing) sets
            # OMNIST_LOCAL_NOTHINK; stage 1/2 keep thinking on. Global-off cost qwen ~1.4 composite pts (3.1 vs 4.5).
            kw["extra_body"] = {"chat_template_kwargs": {"enable_thinking": False}}
    if tools is not None:
        kw["tools"] = tools; kw["tool_choice"] = tool_choice
    if cl is client or cl is _local_client or cl is _openrouter_client:   # gateway + local + openrouter take temperature/seed
        kw["temperature"] = temperature
        if seed is not None:
            kw["seed"] = seed
    return cl.chat.completions.create(**kw)


_LOCK = threading.Lock()
U = {}   # model -> {"in","out","calls","mm_calls"}   (mm_calls = calls that included an image)
PRICE = {"claude-sonnet-4-6": (3.0, 15.0),
         "claude-sonnet-5": (2.0, 10.0),        # INTRODUCTORY through 2026-08-31 (reverts to standard 3.0/15.0)
         "claude-opus-4-8": (5.0, 25.0),        # most capable Opus tier (2.5x sonnet-5 intro price; half of fable-5)
         "claude-fable-5": (10.0, 50.0),        # Anthropic's most capable widely-released model (5x sonnet-5 intro price)
         "claude-mythos-5": (10.0, 50.0),       # same tier/price as fable-5 (Project Glasswing only)
         "gpt-5.4": (1.25, 10.0),
         "gpt-5.5": (5.0, 30.0), "gpt-5.5-pro": (30.0, 180.0),
         # gpt-5.6 standard tier, read off OpenAI's own pricing page 2026-08-15 (was previously all three
         # ESTIMATED at the 5.5 tier, which overstated luna by 25x). NOT the batch/flex tier, which is half.
         "gpt-5.6-luna": (0.20, 1.20), "gpt-5.6-terra": (2.0, 12.0), "gpt-5.6-sol": (5.0, 30.0),
         "or/minimax/minimax-m3": (0.30, 1.20), "or/stepfun/step-3.7-flash": (0.20, 1.15),       # OpenRouter real pricing (2026-07)
         "or/bytedance-seed/seed-1.6": (0.25, 2.00),
         "or/z-ai/glm-5.2": (0.41, 1.28), "or/moonshotai/kimi-k2.7-code": (0.72, 3.49),
         "or/qwen/qwen3.7-max": (1.25, 3.75)}


def chat(content, model, max_tokens=700, temperature=0.0, seed=0, label=""):
    is_mm = isinstance(content, list) and any(isinstance(c, dict) and c.get("type") == "image_url" for c in content)
    _inlen = (len(content) if isinstance(content, str)
              else sum(len(x.get("text", "")) if isinstance(x, dict) else len(str(x)) for x in content)
              if isinstance(content, list) else len(str(content)))
    last = None
    for attempt in range(4):                                # ride through transient gateway blips (500 / timeout)
        try:
            r = create(model, [{"role": "user", "content": content}], max_tokens=max_tokens,
                       temperature=temperature, seed=seed)
            u = getattr(r, "usage", None)
            with _LOCK:
                m = U.setdefault(model, {"in": 0, "out": 0, "calls": 0, "mm_calls": 0, "cread": 0, "cwrite": 0})
                if u:
                    m["in"] += getattr(u, "prompt_tokens", 0) or 0
                    m["out"] += getattr(u, "completion_tokens", 0) or 0
                    m["cread"] += getattr(u, "cache_read_input_tokens", 0) or 0        # Anthropic: cached read (separate from 'in')
                    m["cwrite"] += getattr(u, "cache_creation_input_tokens", 0) or 0
                    ptd = getattr(u, "prompt_tokens_details", None)                    # OpenAI: cached tokens live inside prompt_tokens
                    if ptd is not None:
                        m["cread"] += getattr(ptd, "cached_tokens", 0) or 0
                m["calls"] += 1; m["mm_calls"] += int(is_mm)
            # 推理型模型（deepseek-v4-*、GLM 等）在思考预算吃满时会把答案放进 reasoning_content，
            # content 返回空串。只读 content 的话拿到的是空回复，agent loop 会静默空转重试。
            _msg = r.choices[0].message
            resp = _msg.content or getattr(_msg, "reasoning_content", None) or ""
            print("  [chat] %-24s in=%5dc out=%5dc  cap=%d tok" % ((label or "-")[:24], _inlen, len(resp), max_tokens))
            return resp
        except Exception as e:
            last = e; time.sleep(3 * (attempt + 1))
    raise last


def model_cost(model, ic, oc):
    pin, pout = PRICE.get(model, (3.0, 15.0))
    return ic / 1e6 * pin + oc / 1e6 * pout


def img_block(path, detail="high"):
    with open(path, "rb") as f:
        raw = f.read()
    b = base64.b64encode(raw).decode()
    mt = "image/png"                                      # detect real media type from magic bytes (png vs jpeg vs ...)
    if raw[:2] == b"\xff\xd8":
        mt = "image/jpeg"
    elif raw[:4] == b"GIF8":
        mt = "image/gif"
    elif raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        mt = "image/webp"
    return {"type": "image_url", "image_url": {"url": f"data:{mt};base64,{b}", "detail": detail}}


def spend():
    tot = 0.0
    for m, d in U.items():
        if str(m).startswith("local/"):                 # open-weight backbone on own GPU -> $0, don't hit the 3/15 fallback
            continue
        pin, pout = PRICE.get(m, (3.0, 15.0))
        tot += (d.get("in", 0) * pin + d.get("cwrite", 0) * pin * 1.25       # cache write = 1.25x input price
                + d.get("cread", 0) * pin * 0.10 + d.get("out", 0) * pout) / 1e6   # cache read = 0.10x input price
    return tot


def parse_json(txt):
    for m in re.finditer(r"\{(?:[^{}]|\{[^{}]*\})*\}", txt or "", re.S):
        try:
            return json.loads(m.group(0))
        except Exception:
            continue
    return None


    main()
