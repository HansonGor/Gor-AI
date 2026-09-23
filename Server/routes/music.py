"""
音乐随机播放路由
职责：调用 Jamendo API 拉取 pop 流行曲风歌曲，随机抽取一首，过滤无有效音频的曲目，
仅返回歌曲名称、歌手、封面、mp3 流地址。client_id 只保存在后端，前端不可见。
"""
import random
import httpx
from fastapi import APIRouter, HTTPException

from config import config

router = APIRouter()

JAMENDO_TRACKS_URL = "https://api.jamendo.com/v3.0/tracks/"


@router.get("/music/random")
async def get_random_music():
    """随机返回一首流行歌曲的元数据与 mp3 播放地址"""
    client_id = config.Jamendo.CLIENT_ID
    if not client_id:
        raise HTTPException(status_code=500, detail="Jamendo client_id 未配置")

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            params = {
                "client_id": client_id,
                "format": "json",
                "tags": "pop",
                "limit": 50,
                "audioformat": "mp32",
            }
            resp = await client.get(JAMENDO_TRACKS_URL, params=params)
            data = resp.json()

            if data.get("headers", {}).get("status") != "success":
                raise HTTPException(status_code=502, detail=f"Jamendo API 返回异常: {data.get('headers', {}).get('status')}")

            results = data.get("results", [])
            # 过滤掉没有有效音频播放地址的曲目
            valid = [t for t in results if t.get("audio") and t.get("name")]
            if not valid:
                raise HTTPException(status_code=502, detail="暂无可用曲目")

            track = random.choice(valid)
            return {
                "name": track.get("name", ""),
                "artist": track.get("artist_name", ""),
                "cover": track.get("image", ""),
                "audio": track.get("audio", ""),
                "duration": track.get("duration", 0),
            }

    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Jamendo API 请求超时")
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Jamendo API 请求失败: {str(e)}")
