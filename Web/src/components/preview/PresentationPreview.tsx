import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { PresentationBackground, PresentationSchema } from '../../types';
import './PresentationPreview.less';

const themes = {
  'modern-light': ['#f4f7ff', '#ffffff', '#17233d', '#4b63d3', '#7182bd', '#dfe6fa'],
  'modern-dark': ['#111827', '#1b2435', '#f3f6ff', '#9aafff', '#c2cbe0', '#38445b'],
  business: ['#eef2f6', '#ffffff', '#152a40', '#167c80', '#587083', '#ced9e2'],
  minimal: ['#f8f7f3', '#fffefa', '#292929', '#8f6c50', '#69645e', '#e7e2d9'],
  technology: ['#101427', '#1b2039', '#f0f3ff', '#8b9cff', '#b9c2e3', '#3b4262'],
} as const;

function SlideBody({ slide, colors }: { slide: PresentationSchema['slides'][number]; colors: readonly string[] }) {
  const points = slide.supportingPoints ?? [];
  if (slide.type === 'metrics' || slide.type === 'big-number') {
    return <div className="ppt-metrics">{(slide.metrics ?? []).map((metric: any, index: number) => <div className="ppt-metric" key={`${metric.label}-${index}`}><span>{metric.label}</span><strong>{metric.value}</strong>{metric.note && <small>{metric.note}</small>}</div>)}</div>;
  }
  if (slide.type === 'chart' && slide.chart) {
    const values = slide.chart.series?.[0]?.values ?? [];
    const max = Math.max(1, ...values.map((value: number) => Math.abs(value)));
    return <div className="ppt-chart"><h3>{slide.chart.title}</h3><div className="ppt-chart-bars">{values.map((value: number, index: number) => <div key={`${index}`} className="ppt-chart-column"><strong>{value}{slide.chart.unit ?? ''}</strong><i style={{ height: `${Math.max(8, Math.abs(value) / max * 100)}%`, background: index === 0 ? colors[3] : colors[4] }} /><span>{slide.chart.categories[index]}</span></div>)}</div></div>;
  }
  if (slide.type === 'table' && slide.table) {
    return <div className="ppt-table-wrap"><table><thead><tr>{slide.table.headers.map((cell: string) => <th key={cell}>{cell}</th>)}</tr></thead><tbody>{slide.table.rows.map((row: string[], index: number) => <tr key={index}>{row.map((cell, col) => <td key={col}>{cell}</td>)}</tr>)}</tbody></table></div>;
  }
  if (slide.type === 'timeline' || slide.type === 'process') {
    return <div className="ppt-timeline">{(slide.timeline ?? []).map((item: any, index: number) => <article key={`${item.label}-${index}`}><b>{item.label}</b><strong>{item.title}</strong><p>{item.detail}</p></article>)}</div>;
  }
  if (slide.type === 'quote') return <blockquote>“{slide.quote}”<cite>{slide.attribution}</cite></blockquote>;
  if (slide.type === 'image-text' || slide.type === 'full-image') return <div className="ppt-visual-layout"><div className="ppt-vector-visual"><i /><i /><i /></div>{points.length > 0 && <ul>{points.map((point: string) => <li key={point}>{point}</li>)}</ul>}</div>;
  if (slide.type === 'comparison' || slide.type === 'cards') return <div className="ppt-cards">{points.map((point: string, index: number) => <article key={`${index}-${point}`}><i style={{ background: index ? colors[4] : colors[3] }} /><p>{point}</p></article>)}</div>;
  return <ul className="ppt-points">{(points.length ? points : slide.keyMessage ? [slide.keyMessage] : []).map((point: string) => <li key={point}>{point}</li>)}</ul>;
}

export default function PresentationPreview({ schema, backgrounds }: { schema: PresentationSchema; backgrounds?: Record<string, PresentationBackground> }) {
  const [active, setActive] = useState(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const [availableSize, setAvailableSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const updateSize = () => {
      const style = getComputedStyle(stage);
      setAvailableSize({
        width: Math.max(0, stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)),
        height: Math.max(0, stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)),
      });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);
  const themeName = schema.theme in themes ? schema.theme : 'modern-dark';
  const colors = themes[themeName];
  const slide = schema.slides[Math.min(active, Math.max(0, schema.slides.length - 1))];
  const slideWidth = schema.aspectRatio === '4:3' ? 960 : 1280;
  const slideHeight = 720;
  const scale = availableSize.width && availableSize.height
    ? Math.min(availableSize.width / slideWidth, availableSize.height / slideHeight)
    : 0;
  const photo = slide ? backgrounds?.[slide.id] : undefined;
  const photoTint = themeName === 'modern-dark' || themeName === 'technology' ? 55 : 65;
  const slideStyle: CSSProperties = {
    width: slideWidth,
    height: slideHeight,
    transform: `scale(${scale})`,
    ...(photo ? {
      backgroundImage: `linear-gradient(color-mix(in srgb, var(--ppt-bg) ${photoTint}%, transparent), color-mix(in srgb, var(--ppt-bg) ${photoTint}%, transparent)), url("${photo.url}")`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
    } : {}),
  };
  const palette = useMemo(() => ({ '--ppt-bg': colors[0], '--ppt-surface': colors[1], '--ppt-text': colors[2], '--ppt-accent': colors[3], '--ppt-muted': colors[4], '--ppt-border': colors[5] } as CSSProperties), [colors]);
  if (!slide) return <div className="presentation-preview-empty">没有可预览的幻灯片</div>;
  return <div className="presentation-preview" style={palette}>
    <aside className="ppt-thumbnails" aria-label="幻灯片缩略图">{schema.slides.map((item, index) => <button type="button" key={item.id} className={index === active ? 'active' : ''} onClick={() => setActive(index)} aria-label={`第 ${index + 1} 页：${item.title || item.type}`}><span>{String(index + 1).padStart(2, '0')}</span><b>{item.title || item.type}</b></button>)}</aside>
    <div className="ppt-stage">
      <div className="ppt-toolbar"><span>{schema.title}</span><div><button type="button" onClick={() => setActive((value) => Math.max(0, value - 1))} disabled={active === 0} aria-label="上一页"><ChevronLeft size={18} /></button><span>{active + 1} / {schema.slides.length}</span><button type="button" onClick={() => setActive((value) => Math.min(schema.slides.length - 1, value + 1))} disabled={active === schema.slides.length - 1} aria-label="下一页"><ChevronRight size={18} /></button></div></div>
      <div className="ppt-stage-scroll" ref={stageRef}><div className="ppt-slide-frame" style={{ width: slideWidth * scale, height: slideHeight * scale }}><article className={`ppt-slide ppt-slide-${slide.type}`} style={slideStyle}>
        {slide.eyebrow && <span className="ppt-eyebrow">{slide.eyebrow}</span>}
        {slide.title && <h1>{slide.title}</h1>}{slide.subtitle && <p className="ppt-subtitle">{slide.subtitle}</p>}
        {slide.keyMessage && !['cover', 'section', 'metrics', 'big-number', 'quote'].includes(slide.type) && <p className="ppt-key-message">{slide.keyMessage}</p>}
        <SlideBody slide={slide} colors={colors} />
        {slide.sources?.length ? <footer>来源：{slide.sources.join(' · ')}</footer> : null}
        {photo && <span className="ppt-credit">Photo by <a href={photo.photoUrl} target="_blank" rel="noreferrer">{photo.photographer}</a> on <a href="https://www.pexels.com" target="_blank" rel="noreferrer">Pexels</a></span>}
        <small className="ppt-page">{String(active + 1).padStart(2, '0')}</small>
      </article></div></div>
    </div>
  </div>;
}
