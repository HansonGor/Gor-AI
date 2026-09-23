"""
天气查询路由
职责：接收经纬度，调用高德逆地理编码 + 天气 API，返回城市名、温度、天气状况
"""
import httpx
from fastapi import APIRouter, Query, HTTPException

from config import config

router = APIRouter()

# 高德天气状况 → emoji 图标映射
WEATHER_ICON_MAP = {
    "晴": "☀️",
    "少云": "🌤️",
    "晴间多云": "⛅",
    "多云": "⛅",
    "阴": "☁️",
    "有风": "💨",
    "平静": "🍃",
    "微风": "🍃",
    "和风": "🍃",
    "清风": "🍃",
    "强风": "💨",
    "疾风": "💨",
    "大风": "💨",
    "烈风": "🌬️",
    "风暴": "🌪️",
    "狂爆风": "🌪️",
    "飓风": "🌀",
    "热带风暴": "🌀",
    "霾": "🌫️",
    "中度霾": "🌫️",
    "重度霾": "🌫️",
    "严重霾": "🌫️",
    "雾": "🌫️",
    "浓雾": "🌫️",
    "强浓雾": "🌫️",
    "轻雾": "🌫️",
    "大雾": "🌫️",
    "特强浓雾": "🌫️",
    "阵雨": "🌦️",
    "雷阵雨": "⛈️",
    "雷阵雨并伴有冰雹": "⛈️",
    "小雨": "🌧️",
    "中雨": "🌧️",
    "大雨": "🌧️",
    "极端降雨": "🌧️",
    "暴雨": "⛈️",
    "大暴雨": "⛈️",
    "特大暴雨": "⛈️",
    "冻雨": "🌧️",
    "小到中雨": "🌧️",
    "中到大雨": "🌧️",
    "大到暴雨": "⛈️",
    "暴雨到大暴雨": "⛈️",
    "大暴雨到特大暴雨": "⛈️",
    "雨夹雪": "🌨️",
    "小雪": "❄️",
    "中雪": "❄️",
    "大雪": "❄️",
    "暴雪": "❄️",
    "小到中雪": "❄️",
    "中到大雪": "❄️",
    "大到暴雪": "❄️",
    "浮尘": "🌫️",
    "扬沙": "🌫️",
    "沙尘暴": "🌪️",
    "强沙尘暴": "🌪️",
}


def get_weather_icon(weather: str) -> str:
    """根据天气状况返回 emoji 图标，未匹配时返回 🌡️"""
    return WEATHER_ICON_MAP.get(weather, "🌡️")


@router.get("/weather")
async def get_weather(
    lat: float = Query(..., description="纬度", ge=-90, le=90),
    lng: float = Query(..., description="经度", ge=-180, le=180),
):
    """
    根据经纬度获取城市名和实时天气

    - 调用高德逆地理编码获取城市名和 adcode
    - 调用高德天气 API 获取实时温度和天气状况
    """
    api_key = config.Amap.WEB_SERVICE_KEY
    if not api_key:
        raise HTTPException(status_code=500, detail="高德 Web 服务 Key 未配置")

    # 高德 location 参数格式：经度,纬度
    location = f"{lng},{lat}"

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            # 1. 逆地理编码：经纬度 → 城市名 + adcode
            regeo_url = "https://restapi.amap.com/v3/geocode/regeo"
            regeo_params = {
                "key": api_key,
                "location": location,
                "extensions": "base",
            }
            regeo_resp = await client.get(regeo_url, params=regeo_params)
            regeo_data = regeo_resp.json()

            if regeo_data.get("status") != "1":
                raise HTTPException(status_code=502, detail=f"逆地理编码失败: {regeo_data.get('info', 'unknown')}")

            regeo_component = regeo_data.get("regeocode", {}).get("addressComponent", {})
            city = regeo_component.get("city") or regeo_component.get("province", "")
            # 直辖市的 city 可能为空，用 district 或 province 代替
            if not city:
                city = regeo_component.get("district") or regeo_component.get("province", "未知城市")
            adcode = regeo_component.get("adcode", "")

            # 2. 实时天气查询
            weather_url = "https://restapi.amap.com/v3/weather/weatherInfo"
            weather_params = {
                "key": api_key,
                "city": adcode,
                "extensions": "base",
            }
            weather_resp = await client.get(weather_url, params=weather_params)
            weather_data = weather_resp.json()

            if weather_data.get("status") != "1":
                raise HTTPException(status_code=502, detail=f"天气查询失败: {weather_data.get('info', 'unknown')}")

            lives = weather_data.get("lives", [])
            if not lives:
                raise HTTPException(status_code=502, detail="天气数据为空")

            live = lives[0]
            temperature = live.get("temperature", "")
            weather_desc = live.get("weather", "")
            icon = get_weather_icon(weather_desc)

            return {
                "city": city,
                "temperature": temperature,
                "weather": weather_desc,
                "icon": icon,
                "adcode": adcode,
                "province": regeo_component.get("province", ""),
            }

    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="高德 API 请求超时")
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"高德 API 请求失败: {str(e)}")
