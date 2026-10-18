"""
天气查询工具
职责：用高德天气查询城市实况与未来几天预报；高德不可用时退到 wttr.in（实况加未来 3 天预报，精度较低）。
失败时返回以“查询天气失败：”开头的文本，写明各来源的具体原因，供模型和用户判断。
"""
from datetime import datetime, timedelta, timezone

import httpx
from langchain_core.tools import tool

from config import config

AMAP_GEOCODE_URL = "https://restapi.amap.com/v3/geocode/geo"
AMAP_WEATHER_URL = "https://restapi.amap.com/v3/weather/weatherInfo"
WTTR_URL = "https://wttr.in/{city}?format=j1&lang=zh"
CHINA_TZ = timezone(timedelta(hours=8))   # 中国不实行夏令时；避免 Windows 缺少 tzdata
WEEKDAYS = {"1": "周一", "2": "周二", "3": "周三", "4": "周四", "5": "周五", "6": "周六", "7": "周日"}
DAY_LABELS = {0: "今天", 1: "明天", 2: "后天"}


class WeatherError(Exception):
    """某个天气来源失败；message 是可直接展示给用户的中文原因。"""


def _new_client() -> httpx.Client:
    return httpx.Client(timeout=10.0)


def _today() -> datetime:
    return datetime.now(CHINA_TZ)


def _reason(error: Exception) -> str:
    """把网络/解析异常归类为中文原因；不回显异常原文（可能含请求参数）。"""
    if isinstance(error, WeatherError):
        return str(error)
    if isinstance(error, httpx.TimeoutException):
        return "请求超时"
    if isinstance(error, (httpx.ConnectError, httpx.RemoteProtocolError, httpx.ReadError)) or "SSL" in str(error):
        return "网络连接失败（当前网络可能无法访问该服务）"
    if isinstance(error, httpx.HTTPStatusError):
        return f"服务返回错误状态 {error.response.status_code}"
    if isinstance(error, (ValueError, KeyError, IndexError, TypeError)):
        return "返回的数据格式无法解析"
    return f"未知错误（{type(error).__name__}）"


def _amap_get(client: httpx.Client, url: str, params: dict) -> dict:
    response = client.get(url, params=params)
    response.raise_for_status()
    data = response.json()
    if data.get("status") != "1":
        info = str(data.get("info") or "未知").strip()
        raise WeatherError(f"高德接口拒绝了请求（{info[:40]}）")
    return data


def _day_label(date_text: str, today: datetime) -> str:
    try:
        day = datetime.strptime(date_text, "%Y-%m-%d").date()
    except ValueError:
        return date_text
    label = DAY_LABELS.get((day - today.date()).days, "")
    return f"{label}（{day.month}月{day.day}日）" if label else f"{day.month}月{day.day}日"


def _wind(direction: str, power: str) -> str:
    return f"{direction}风{power}级" if direction and direction != "无" and power else ""


def _query_amap(city: str, today: datetime) -> str:
    key = (config.Amap.WEB_SERVICE_KEY or "").strip()
    if not key:
        raise WeatherError("未配置高德 Web 服务密钥（AMAP_WEB_SERVICE_KEY2）")
    with _new_client() as client:
        geo = _amap_get(client, AMAP_GEOCODE_URL, {"key": key, "address": city, "output": "JSON"})
        places = geo.get("geocodes") or []
        adcode = places[0].get("adcode") if places else ""
        if not adcode or isinstance(adcode, list):
            raise WeatherError(f"没有找到名为“{city}”的城市")
        live_data = _amap_get(client, AMAP_WEATHER_URL, {"key": key, "city": adcode, "extensions": "base"})
        forecast_data = _amap_get(client, AMAP_WEATHER_URL, {"key": key, "city": adcode, "extensions": "all"})
    lives = live_data.get("lives") or []
    forecasts = forecast_data.get("forecasts") or []
    if not lives and not forecasts:
        raise WeatherError("高德没有返回该城市的天气数据")

    name = (lives[0].get("city") if lives else forecasts[0].get("city")) or city
    reported = (lives[0].get("reporttime") if lives else forecasts[0].get("reporttime")) or ""
    lines = [f"【{name}天气】（来源：高德天气" + (f"，{reported[:16]}发布" if reported else "") + "）"]
    if lives:
        live = lives[0]
        wind = _wind(live.get("winddirection", ""), live.get("windpower", ""))
        parts = [live.get("weather", ""), f"{live.get('temperature', '')}℃", f"湿度 {live.get('humidity', '')}%", wind]
        lines.append("当前：" + "，".join(p for p in parts if p and not p.startswith("℃") and p != "湿度 %"))
    casts = forecasts[0].get("casts") if forecasts else []
    if casts:
        lines.append("未来预报：")
        for cast in casts:
            label = _day_label(cast.get("date", ""), today)
            week = WEEKDAYS.get(str(cast.get("week", "")), "")
            day_wind = _wind(cast.get("daywind", ""), cast.get("daypower", ""))
            night_wind = _wind(cast.get("nightwind", ""), cast.get("nightpower", ""))
            lines.append(
                f"- {label}{(' ' + week) if week else ''}：白天{cast.get('dayweather', '')} {cast.get('daytemp', '')}℃"
                f"，夜间{cast.get('nightweather', '')} {cast.get('nighttemp', '')}℃"
                + (f"；白天{day_wind}" if day_wind else "") + (f"，夜间{night_wind}" if night_wind else ""))
    else:
        lines.append("未来预报：高德本次没有返回预报数据。")
    return "\n".join(lines)


def _wttr_desc(hour: dict) -> str:
    zh = hour.get("lang_zh") or hour.get("weatherDesc") or [{}]
    return str(zh[0].get("value", "")).strip()


def _query_wttr(city: str, today: datetime) -> str:
    with _new_client() as client:
        response = client.get(WTTR_URL.format(city=city))
        response.raise_for_status()
        data = response.json()
    current = data["current_condition"][0]
    lines = [
        f"【{city}天气】（来源：wttr.in，精度不如高德，仅供参考）",
        f"当前：{_wttr_desc(current)}，{current['temp_C']}℃（体感 {current['FeelsLikeC']}℃），"
        f"湿度 {current['humidity']}%，风速 {current['windspeedKmph']} km/h",
    ]
    days = data.get("weather") or []
    if days:
        lines.append("未来预报：")
    for day in days:
        hours = day.get("hourly") or []
        rain_chance = max((int(h.get("chanceofrain") or 0) for h in hours), default=0)
        rain_mm = sum(float(h.get("precipMM") or 0) for h in hours)
        noon = _wttr_desc(hours[4]) if len(hours) > 4 else (_wttr_desc(hours[0]) if hours else "")
        lines.append(
            f"- {_day_label(day.get('date', ''), today)}：{noon}，{day.get('mintempC')}～{day.get('maxtempC')}℃，"
            f"最大降雨概率 {rain_chance}%，预计降水 {rain_mm:.1f} mm")
    return "\n".join(lines)


@tool
def get_weather(city: str) -> str:
    """
    查询指定城市的天气：当前实况加未来几天预报（含“明天”“后天”），来源为高德天气。

    Args:
        city: 城市名称，例如"广州"、"北京"、"上海"

    Returns:
        天气信息文本；查询失败时以“查询天气失败：”开头并写明原因。
    """
    city = (city or "").strip()
    if not city:
        return "查询天气失败：没有提供城市名称"
    try:
        return _query_amap(city, _today())
    except Exception as amap_error:
        amap_reason = _reason(amap_error)
    try:
        text = _query_wttr(city, _today())
    except Exception as wttr_error:
        return (f"查询天气失败：高德天气：{amap_reason}；备用来源 wttr.in：{_reason(wttr_error)}。"
                "请改用联网搜索核对天气预报，不要重复调用本工具。")
    return (f"{text}\n（高德天气不可用：{amap_reason}。以上是备用来源 wttr.in 的实况与未来 3 天预报，"
            "精度不如高德，回答时请说明来源。）")
