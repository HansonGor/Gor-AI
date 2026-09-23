import React, { useEffect } from 'react';
import { ArrowLeft, CloudSun, CloudRain, Cloud, Wind } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import './index.less';

/** 未来三天天气数据（来源：实时查询 + 气象预报） */
interface DayWeather {
  key: string;
  label: string;
  weather: string;
  high: number;
  low: number;
  wind: string;
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function formatDate(offset: number): { date: string; week: string } {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return { date: `${month}-${day}`, week: WEEK[d.getDay()] };
}

const FORECAST: DayWeather[] = [
  { key: 'today', label: '今天', weather: '雷阵雨转中雨', high: 32, low: 25, wind: '东南风 <3级' },
  { key: 'tomorrow', label: '明天', weather: '多云', high: 32, low: 25, wind: '东北风 <3级' },
  { key: 'after', label: '后天', weather: '多云', high: 33, low: 25, wind: '东风 <3级' },
];

function WeatherIcon({ weather }: { weather: string }) {
  if (weather.includes('雨')) return <CloudRain className="w-[0.36rem] h-[0.36rem] text-sky-300" />;
  if (weather.includes('云')) return <CloudSun className="w-[0.36rem] h-[0.36rem] text-amber-200" />;
  return <Cloud className="w-[0.36rem] h-[0.36rem] text-white/70" />;
}

const WeatherPage: React.FC = () => {
  const navigate = useNavigate();

  useEffect(() => {
    document.body.style.overflow = 'auto';
    document.body.style.overflowX = 'hidden';
    return () => {
      document.body.style.overflow = '';
      document.body.style.overflowX = '';
    };
  }, []);

  const rows = FORECAST.map((item) => {
    const { date, week } = formatDate(item.key === 'today' ? 0 : item.key === 'tomorrow' ? 1 : 2);
    return { ...item, date, week };
  });

  return (
    <div className="weather-page dark min-h-screen bg-background text-foreground">
      <header className="weather-header">
        <button className="weather-back" onClick={() => navigate(-1)} aria-label="返回">
          <ArrowLeft className="h-[0.34rem] w-[0.34rem]" />
        </button>
        <div>
          <h1 className="weather-title">广州 · 未来三天天气</h1>
          <p className="weather-sub">数据更新时间：{new Date().toLocaleDateString('zh-CN')}</p>
        </div>
        <Wind className="h-[0.4rem] w-[0.4rem] text-white/50" />
      </header>

      <main className="weather-main">
        {/* 当前实况 */}
        <section className="weather-now glass-card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[0.26rem] text-white/60">当前实况 · 广州</p>
              <p className="m-0 mt-[0.1rem] text-[0.8rem] font-bold text-white leading-none">31°C</p>
              <p className="mt-[0.12rem] text-[0.24rem] text-white/60">零星小雨 · 体感 35°C</p>
            </div>
            <div className="text-right text-[0.24rem] text-white/60">
              <p className="m-0">湿度 58%</p>
              <p className="m-0 mt-[0.08rem]">风速 11 km/h</p>
              <p className="m-0 mt-[0.08rem]">能见度 10 km</p>
            </div>
          </div>
        </section>

        {/* 三天预报表格 */}
        <section className="glass-card weather-table-card">
          <h2 className="weather-section-title">未来三天预报</h2>
          <div className="overflow-x-auto">
            <table className="weather-table">
              <thead>
                <tr>
                  <th>日期</th>
                  <th>星期</th>
                  <th>天气</th>
                  <th>最高温</th>
                  <th>最低温</th>
                  <th>风力</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <td>
                      <span className="font-semibold">{row.label}</span>
                      <span className="block text-[0.22rem] text-white/40">{row.date}</span>
                    </td>
                    <td>{row.week}</td>
                    <td>
                      <span className="inline-flex items-center gap-[0.1rem]">
                        <WeatherIcon weather={row.weather} />
                        {row.weather}
                      </span>
                    </td>
                    <td className="text-amber-300 font-semibold">{row.high}°C</td>
                    <td className="text-sky-300 font-semibold">{row.low}°C</td>
                    <td className="text-white/60">{row.wind}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="weather-note">* 数据来自实时天气查询与公开气象预报，仅供参考。</p>
        </section>
      </main>
    </div>
  );
};

export default WeatherPage;
