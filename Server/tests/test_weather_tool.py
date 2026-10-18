"""天气工具：高德为主（实况 + 未来预报），高德不可用时退到 wttr.in，失败原因写明且不泄露密钥。"""

from datetime import datetime

import httpx
import pytest

from config import config
from tools import weather

SECRET = "SECRET-KEY-123"
TODAY = datetime(2026, 10, 18, 9, 0, tzinfo=weather.CHINA_TZ)

GEO = {"status": "1", "geocodes": [{"adcode": "440100", "city": "广州市"}]}
LIVE = {"status": "1", "lives": [{"city": "广州市", "weather": "多云", "temperature": "29", "humidity": "70",
                                   "winddirection": "南", "windpower": "≤3", "reporttime": "2026-10-18 08:32:11"}]}
FORECAST = {"status": "1", "forecasts": [{"city": "广州市", "reporttime": "2026-10-18 08:32:11", "casts": [
    {"date": "2026-10-18", "week": "7", "dayweather": "多云", "nightweather": "多云", "daytemp": "33", "nighttemp": "26",
     "daywind": "南", "nightwind": "南", "daypower": "≤3", "nightpower": "≤3"},
    {"date": "2026-10-19", "week": "1", "dayweather": "小雨", "nightweather": "阴", "daytemp": "30", "nighttemp": "25",
     "daywind": "东南", "nightwind": "无", "daypower": "4", "nightpower": ""},
    {"date": "2026-10-21", "week": "3", "dayweather": "晴", "nightweather": "晴", "daytemp": "34", "nighttemp": "27",
     "daywind": "无", "nightwind": "无", "daypower": "", "nightpower": ""},
]}]}
WTTR = {
    "current_condition": [{"lang_zh": [{"value": "晴"}], "temp_C": "27", "FeelsLikeC": "30", "humidity": "70",
                           "windspeedKmph": "11"}],
    "weather": [
        {"date": "2026-10-18", "maxtempC": "33", "mintempC": "26", "hourly": [
            {"chanceofrain": "5", "precipMM": "0.0", "weatherDesc": [{"value": "Clear"}]}] * 8},
        {"date": "2026-10-19", "maxtempC": "35", "mintempC": "26", "hourly": [
            {"chanceofrain": "17" if i == 1 else "3", "precipMM": "0.4" if i == 1 else "0.0",
             "lang_zh": [{"value": "多云"}], "weatherDesc": [{"value": "Cloudy"}]} for i in range(8)]},
    ],
}


def install(monkeypatch, handler, key=SECRET):
    monkeypatch.setattr(config.Amap, "WEB_SERVICE_KEY", key)
    monkeypatch.setattr(weather, "_new_client", lambda: httpx.Client(transport=httpx.MockTransport(handler)))
    monkeypatch.setattr(weather, "_today", lambda: TODAY)


def amap_ok(request: httpx.Request) -> httpx.Response:
    if "geocode/geo" in request.url.path:
        return httpx.Response(200, json=GEO)
    return httpx.Response(200, json=FORECAST if request.url.params.get("extensions") == "all" else LIVE)


def run(city="广州"):
    return weather.get_weather.invoke({"city": city})


def test_amap_returns_live_and_labelled_forecast(monkeypatch):
    seen = []
    install(monkeypatch, lambda r: (seen.append(r), amap_ok(r))[1])
    text = run()
    assert text.startswith("【广州市天气】（来源：高德天气，2026-10-18 08:32发布）")
    assert "当前：多云，29℃，湿度 70%，南风≤3级" in text
    assert "- 今天（10月18日） 周日：白天多云 33℃，夜间多云 26℃；白天南风≤3级，夜间南风≤3级" in text
    # “明天”必须直接标出，且下雨信息就在这一行
    assert "- 明天（10月19日） 周一：白天小雨 30℃，夜间阴 25℃；白天东南风4级" in text
    assert "- 10月21日 周三：" in text            # 超过后天不加相对称呼
    assert "无风" not in text and "无级" not in text
    assert not text.startswith("查询天气失败")
    assert [r.url.params.get("extensions") for r in seen[1:]] == ["base", "all"]
    assert all(r.url.params.get("key") == SECRET for r in seen)   # 只在请求里使用，不进入结果


def test_amap_missing_key_falls_back_to_wttr_with_reason(monkeypatch):
    install(monkeypatch, lambda r: httpx.Response(200, json=WTTR), key="")
    text = run()
    assert "来源：wttr.in" in text
    assert "- 明天（10月19日）：多云，26～35℃，最大降雨概率 17%，预计降水 0.4 mm" in text
    assert "高德天气不可用：未配置高德 Web 服务密钥（AMAP_WEB_SERVICE_KEY2）" in text
    assert "精度不如高德" in text and not text.startswith("查询天气失败")


def test_amap_rejection_reason_is_reported(monkeypatch):
    def handler(request):
        if "wttr.in" in request.url.host:
            return httpx.Response(200, json=WTTR)
        return httpx.Response(200, json={"status": "0", "info": "USERKEY_PLAT_NOMATCH", "infocode": "10009"})
    install(monkeypatch, handler)
    text = run()
    assert "高德天气不可用：高德接口拒绝了请求（USERKEY_PLAT_NOMATCH）" in text
    assert "来源：wttr.in" in text


def test_both_sources_fail_with_explicit_reasons_and_no_secret_leak(monkeypatch):
    def handler(request):
        if "amap" in request.url.host:
            raise httpx.ConnectError(f"[SSL: UNEXPECTED_EOF] key={SECRET}", request=request)
        return httpx.Response(500, json={})
    install(monkeypatch, handler)
    text = run()
    assert text.startswith("查询天气失败：高德天气：网络连接失败（当前网络可能无法访问该服务）")
    assert "备用来源 wttr.in：服务返回错误状态 500" in text
    assert "请改用联网搜索核对天气预报，不要重复调用本工具" in text
    assert SECRET not in text and "UNEXPECTED_EOF" not in text


@pytest.mark.parametrize("error, reason", [
    (httpx.ReadTimeout("x"), "请求超时"),
    (httpx.ConnectError("x"), "网络连接失败"),
    (ValueError("bad json"), "返回的数据格式无法解析"),
    (RuntimeError("boom"), "未知错误（RuntimeError）"),
])
def test_reason_classification(error, reason):
    assert reason in weather._reason(error)


def test_unknown_city_and_blank_city(monkeypatch):
    def handler(request):
        if "geocode/geo" in request.url.path:
            return httpx.Response(200, json={"status": "1", "geocodes": []})
        return httpx.Response(500, json={})
    install(monkeypatch, handler)
    text = run("不存在的地方")
    assert text.startswith("查询天气失败：高德天气：没有找到名为“不存在的地方”的城市")
    assert run("   ") == "查询天气失败：没有提供城市名称"


@pytest.mark.parametrize("env, expected", [
    ({"AMAP_WEB_SERVICE_KEY2": "new-key", "AMAP_WEB_SERVICE_KEY": "old-key"}, "new-key"),   # 新变量优先
    ({"AMAP_WEB_SERVICE_KEY2": "", "AMAP_WEB_SERVICE_KEY": "old-key"}, "old-key"),          # 未配置新变量时兼容旧变量
    ({"AMAP_WEB_SERVICE_KEY2": "", "AMAP_WEB_SERVICE_KEY": ""}, ""),
])
def test_amap_key_prefers_key2_and_stays_backward_compatible(env, expected):
    import os
    import subprocess
    import sys
    result = subprocess.run(
        [sys.executable, "-X", "utf8", "-c", "from config import config; print(config.Amap.WEB_SERVICE_KEY)"],
        capture_output=True, text=True, encoding="utf-8", cwd=os.path.dirname(os.path.dirname(__file__)),
        env={**os.environ, **env})
    assert result.returncode == 0, result.stderr[-300:]
    assert result.stdout.strip() == expected


def test_missing_key_reason_names_the_current_variable(monkeypatch):
    install(monkeypatch, lambda r: httpx.Response(500, json={}), key="")
    assert "AMAP_WEB_SERVICE_KEY2" in run()


def test_failure_prefix_stays_compatible_with_thinking_panel_detection():
    from models.thinking import tool_presentation
    failed = tool_presentation("get_weather", {"city": "广州"}, "查询天气失败：高德天气：请求超时；备用来源 wttr.in：请求超时。", True)
    assert failed["status"] == "fail" and "未成功" in failed["summary"]
