# -*- coding: utf-8 -*-
"""
问津 · Edge-TTS 桥接服务（edge-tts-bridge）
把微软 Edge 神经网络语音（Edge-TTS）包成一个 OpenAI 兼容的 /v1/audio/speech 接口，
问津电脑端 / 手机端在「设置 → 阅读与朗读 → Edge-TTS」里填这个地址即可用上自然人声。

用法：
    pip install edge-tts fastapi uvicorn
    python edge-tts-bridge.py

默认监听 0.0.0.0:8787（同一局域网内手机也能连）。
启动后会打印本机局域网 IP，把它填进手机端设置页的「服务地址」： http://<IP>:8787/v1
"""
import asyncio
import os
import socket
import sys
import tempfile

try:
    import edge_tts
    from fastapi import FastAPI, Request
    from fastapi.responses import Response
    import uvicorn
except ImportError:
    print("缺少依赖，请先执行：  pip install edge-tts fastapi uvicorn")
    sys.exit(1)

app = FastAPI(title="问津 Edge-TTS Bridge")

# 手机 WebView 的源是 http://localhost，跨源请求必须带 CORS 头，
# 且要应答 OPTIONS 预检 —— 否则手机上的朗读请求根本到不了这里。
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Edge-TTS 常用中文音色（与问津设置页下拉一致）
VOICES = [
    "zh-CN-XiaoxiaoNeural", "zh-CN-YunxiNeural", "zh-CN-YunjianNeural",
    "zh-CN-XiaoyiNeural", "zh-CN-YunyangNeural", "zh-CN-XiaochenNeural",
    "zh-CN-shaanxi-XiaoniNeural", "zh-CN-liaoning-XiaobeiNeural",
    "zh-HK-HiuMaanNeural", "zh-TW-HsiaoChenNeural",
]


@app.get("/")
def health():
    return {"ok": True, "service": "wenjin-edge-tts-bridge", "voices": VOICES}


@app.post("/v1/audio/speech")
async def speech(request: Request):
    """OpenAI 兼容语音合成：{model, voice, input, speed, response_format}"""
    try:
        body = await request.json()
    except Exception:
        return Response(content='{"error":"invalid json"}', media_type="application/json", status_code=400)

    text = (body.get("input") or "").strip()
    if not text:
        return Response(content='{"error":"empty input"}', media_type="application/json", status_code=400)
    if len(text) > 3000:
        text = text[:3000]

    voice = body.get("voice") or "zh-CN-XiaoxiaoNeural"
    # 防御：不在白名单的音色回退默认（Edge-TTS 对音色名敏感）
    if voice not in VOICES:
        voice = "zh-CN-XiaoxiaoNeural"

    try:
        speed = float(body.get("speed") or 1.0)
    except (TypeError, ValueError):
        speed = 1.0
    speed = max(0.5, min(2.0, speed))
    # 问津传 0.6~1.8，Edge-TTS 要 "+20%" 这种
    rate = f"{int(round((speed - 1.0) * 100)):+d}%"

    fd, path = tempfile.mkstemp(suffix=".mp3")
    os.close(fd)
    try:
        communicate = edge_tts.Communicate(text, voice, rate=rate)
        await communicate.save(path)
        with open(path, "rb") as f:
            data = f.read()
        return Response(content=data, media_type="audio/mpeg")
    except Exception as e:  # noqa: BLE001
        return Response(
            content='{"error":"tts failed: %s"}' % str(e).replace('"', "'"),
            media_type="application/json",
            status_code=500,
        )
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


if __name__ == "__main__":
    ip = lan_ip()
    print("=" * 56)
    print("  问津 · Edge-TTS 桥接已启动")
    print(f"  本机地址   : http://127.0.0.1:8787")
    print(f"  局域网地址 : http://{ip}:8787/v1   ← 填到手机端 / 电脑端设置页")
    print("  音色白名单 : " + ", ".join(VOICES[:4]) + " …")
    print("  停止       : Ctrl+C")
    print("=" * 56)
    uvicorn.run(app, host="0.0.0.0", port=8787, log_level="warning")
