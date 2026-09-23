"""
天气查询工具
职责：调用 wttr.in 免费 API 查询城市天气
"""
import httpx
from langchain_core.tools import tool


@tool
def get_weather(city: str) -> str:
    """
    查询指定城市的实时天气信息。

    Args:
        city: 城市名称，例如"广州"、"北京"、"上海"

    Returns:
        天气信息文本，包含温度、天气状况、湿度、风速等
    """
    try:
        url = f"https://wttr.in/{city}?format=j1&lang=zh"
        with httpx.Client(timeout=10.0) as client:
            response = client.get(url)
            data = response.json()

        current = data["current_condition"][0]
        weather_desc = current["lang_zh"][0]["value"] if current.get("lang_zh") else current["weatherDesc"][0]["value"]
        temp_c = current["temp_C"]
        feels_like = current["FeelsLikeC"]
        humidity = current["humidity"]
        wind_speed = current["windspeedKmph"]
        visibility = current["visibility"]

        result = f"""【{city}天气】
天气状况：{weather_desc}
当前温度：{temp_c}°C
体感温度：{feels_like}°C
湿度：{humidity}%
风速：{wind_speed} km/h
能见度：{visibility} km"""

        return result
    except Exception as e:
        return f"查询天气失败：{str(e)}"
