import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ChevronLeft, ChevronRight, Play, RotateCcw } from 'lucide-react';
import type {
  PresentationBackground,
  PresentationRenderedSlide,
  PresentationSchema,
} from '../../types';
import './PresentationPreview.less';
import { playMotion } from '../../preview/core/presentationMotion';

const themes = {
  'modern-light': ['#f4f7ff', '#ffffff', '#17233d', '#4b63d3', '#7182bd', '#dfe6fa'],
  'modern-dark': ['#111827', '#1b2435', '#f3f6ff', '#9aafff', '#c2cbe0', '#38445b'],
  business: ['#eef2f6', '#ffffff', '#152a40', '#167c80', '#587083', '#ced9e2'],
  minimal: ['#f8f7f3', '#fffefa', '#292929', '#8f6c50', '#69645e', '#e7e2d9'],
  technology: ['#101427', '#1b2039', '#f0f3ff', '#8b9cff', '#b9c2e3', '#3b4262'],
} as const;

function SlideBody({
  slide,
  colors,
  photo,
}: {
  slide: PresentationSchema['slides'][number];
  colors: readonly string[];
  photo?: PresentationBackground;
}) {
  const points = slide.supportingPoints ?? [];
  const table = slide.table;
  const tableBody = table ? (
    <div className="ppt-table-wrap" data-motion-target="table-group">
      <table><thead><tr>{table.headers.map((cell: string) => <th key={cell}>{cell}</th>)}</tr></thead>
        <tbody>{table.rows.map((row: string[], index: number) => <tr className={table.highlightRows?.includes(index) ? 'ppt-table-highlight' : ''} key={index}>{row.map((cell, col) => <td key={col}>{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
  ) : null;
  if (slide.type === 'metrics' || slide.type === 'big-number') {
    const split =
      slide.type === 'big-number' &&
      slide.metrics?.length === 1 &&
      ['minimal-number', 'oversized-editorial', 'left'].includes(slide.layoutVariant);
    return (
      <div className="ppt-metrics">
        {(slide.metrics ?? []).map((metric: any, index: number) => (
          <div
            className="ppt-metric"
            data-motion-target={split ? undefined : `metric-${index}`}
            key={`${metric.label}-${index}`}
          >
            <span data-motion-target={split ? `metric-label-${index}` : undefined}>
              {metric.label}
            </span>
            <strong data-motion-target={split ? `metric-${index}` : undefined}>
              {metric.value}
            </strong>
            {metric.note && (
              <small data-motion-target={split ? `metric-insight-${index}` : undefined}>
                {metric.note}
              </small>
            )}
          </div>
        ))}
      </div>
    );
  }
  if (slide.type === 'chart' && slide.chart) {
    const values = slide.chart.series?.[0]?.values ?? [];
    const max = Math.max(1, ...values.map((value: number) => Math.abs(value)));
    return (
      <>
        <p data-motion-target="chart-insight" className="ppt-key-message">
          {slide.chart.chartInsight}
        </p>
        <div className="ppt-chart" data-motion-target="chart-group">
          <h3>{slide.chart.title}</h3>
          <div className="ppt-chart-bars">
            {values.map((value: number, index: number) => (
              <div key={`${index}`} className="ppt-chart-column">
                <strong>
                  {value}
                  {slide.chart.unit ?? ''}
                </strong>
                <i
                  style={{
                    height: `${Math.max(8, (Math.abs(value) / max) * 100)}%`,
                    background: index === 0 ? colors[3] : colors[4],
                  }}
                />
                <span>{slide.chart.categories[index]}</span>
              </div>
            ))}
          </div>
        </div>
        <small data-motion-target="chart-highlight">{slide.chart.annotation}</small>
      </>
    );
  }
  if (slide.type === 'table' && table) return tableBody;
  if (slide.type === 'timeline' || slide.type === 'process') {
    return (
      <div className="ppt-timeline">
        {(slide.timeline ?? []).map((item: any, index: number) => (
          <article data-motion-target={`step-${index}`} key={`${item.label}-${index}`}>
            <b>{item.label}</b>
            <strong>{item.title}</strong>
            <p>{item.detail}</p>
          </article>
        ))}
      </div>
    );
  }
  if (slide.type === 'quote')
    return (
      <blockquote>
        <span data-motion-target="quote">“{slide.quote}”</span>
        <cite data-motion-target="author">{slide.attribution}</cite>
      </blockquote>
    );
  if (slide.type === 'image-text' && slide.timeline?.length)
    return (
      <div className={`ppt-journey ppt-journey-${slide.layoutVariant}`}>
        {photo && <img data-motion-target="editorial-image" src={photo.url} alt="与本页行程相关的摄影" />}
        <div className="ppt-journey-steps">
          {slide.timeline.map((item: any, index: number) => (
            <article data-motion-target={`step-${index}`} key={`${item.label}-${index}`}>
              <b>{item.label}</b><strong>{item.title}</strong><p>{item.detail}</p>
            </article>
          ))}
        </div>
      </div>
    );
  if (slide.type === 'image-text' && table)
    return <div className="ppt-image-table">{photo && <img data-motion-target="editorial-image" src={photo.url} alt="与本页主题相关的摄影" />}{tableBody}</div>;
  if (slide.type === 'image-text' || slide.type === 'full-image')
    return (
      <div className="ppt-visual-layout">
        {photo && photo.imageRole !== 'background' ? (
          <img data-motion-target="editorial-image" src={photo.url} alt="与本页内容相关的图片" />
        ) : null}
        {points.length > 0 && (
          <ul>
            {points.map((point: string, index: number) => (
              <li data-motion-target={`point-${index}`} key={index}>
                {point}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  if (slide.type === 'comparison' && table)
    return <div className="ppt-comparison-table">{slide.keyMessage && <p className="ppt-key-message">{slide.keyMessage}</p>}{tableBody}</div>;
  if (slide.type === 'comparison' || slide.type === 'cards')
    return (
      <div className={slide.type === 'cards' && slide.layoutVariant === 'editorial-list' && slide.keyMessage ? 'ppt-cards-editorial' : 'ppt-cards'}>
        <div className="ppt-cards-items">
          {points.map((point: string, index: number) => (
            <article data-motion-target={`card-${index}`} key={`${index}-${point}`}>
              <i style={{ background: index ? colors[4] : colors[3] }} />
              <p>{point}</p>
            </article>
          ))}
        </div>
        {slide.type === 'cards' && slide.layoutVariant === 'editorial-list' && slide.keyMessage && <p className="ppt-cards-aside">{slide.keyMessage}</p>}
      </div>
    );
  if (['cover', 'section'].includes(slide.type)) return null;
  if (slide.type === 'summary' && slide.visualRole === 'closing')
    return <div className="ppt-closing"><p>{slide.keyMessage}</p><small>{points.map((point: string) => point.split('，')[0]).join(' · ')}</small></div>;
  if (slide.type === 'title-content' && slide.layoutVariant === 'editorial-list' && points.length === 5)
    return <ol className="ppt-reminders">{points.map((point: string, index: number) => <li data-motion-target={`point-${index}`} key={index}><b>{String(index + 1).padStart(2, '0')}</b><span>{point}</span></li>)}</ol>;
  return (
    <ul className="ppt-points">
      {(points.length ? points : slide.keyMessage ? [slide.keyMessage] : []).map(
        (point: string, index: number) => (
          <li data-motion-target={`point-${index}`} key={index}>
            {point}
          </li>
        ),
      )}
    </ul>
  );
}

export default function PresentationPreview({
  schema,
  backgrounds,
  renderedSlides,
}: {
  schema: PresentationSchema;
  backgrounds?: Record<string, PresentationBackground>;
  renderedSlides?: PresentationRenderedSlide[];
}) {
  const [active, setActive] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [replay, setReplay] = useState(0);
  const [click, setClick] = useState(0);
  const frameRef = useRef<HTMLDivElement>(null);
  const cleanups = useRef<Array<() => void>>([]);
  const stageRef = useRef<HTMLDivElement>(null);
  const [availableSize, setAvailableSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const updateSize = () => {
      const style = getComputedStyle(stage);
      setAvailableSize({
        width: Math.max(
          0,
          stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        ),
        height: Math.max(
          0,
          stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
        ),
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
  useEffect(() => {
    setActive(0);
    setClick(0);
    setPlaying(Boolean(schema.motionLanguage && schema.motionLanguage.playback !== 'none'));
  }, [schema]);
  useEffect(() => {
    cleanups.current.forEach((cleanup) => cleanup());
    cleanups.current = [];
    setClick(0);
    if (playing && frameRef.current && slide && !slide.motionDisabled) {
      cleanups.current.push(
        playMotion(
          frameRef.current,
          slide.animationTimeline ?? [],
          0,
          colors[3],
          slide.transition,
          matchMedia('(prefers-reduced-motion: reduce)').matches,
        ),
      );
    }
    return () => {
      cleanups.current.forEach((cleanup) => cleanup());
      cleanups.current = [];
    };
  }, [schema, active, replay, playing]);
  useEffect(() => {
    if (click > 0 && playing && frameRef.current && slide && !slide.motionDisabled)
      cleanups.current.push(
        playMotion(
          frameRef.current,
          slide.animationTimeline ?? [],
          click,
          colors[3],
          undefined,
          matchMedia('(prefers-reduced-motion: reduce)').matches,
        ),
      );
  }, [click]);
  const slideWidth = schema.aspectRatio === '4:3' ? 960 : 1280;
  const slideHeight = 720;
  const scale =
    availableSize.width && availableSize.height
      ? Math.min(availableSize.width / slideWidth, availableSize.height / slideHeight)
      : 0;
  const photo = slide ? backgrounds?.[slide.id] : undefined;
  const renderedSlide = slide
    ? renderedSlides?.find((item) => item.slideId === slide.id)
    : undefined;
  const showRendered = Boolean(renderedSlide && !playing);
  const maxClick = Math.max(0, ...(slide?.animationTimeline ?? []).map((cue) => cue.clickIndex));
  const photoIsBackground = photo?.imageRole === 'background' || slide?.imageRole === 'background';
  const slideStyle: CSSProperties = {
    width: slideWidth,
    height: slideHeight,
    transform: `scale(${scale})`,
    ...(photo && photoIsBackground
      ? {
          backgroundImage: `url("${photo.url}")`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }
      : {}),
  };
  const palette = useMemo(
    () =>
      ({
        '--ppt-bg': colors[0],
        '--ppt-surface': colors[1],
        '--ppt-text': colors[2],
        '--ppt-accent': colors[3],
        '--ppt-muted': colors[4],
        '--ppt-border': colors[5],
      }) as CSSProperties,
    [colors],
  );
  if (!slide) return <div className="presentation-preview-empty">没有可预览的幻灯片</div>;
  return (
    <div className="presentation-preview" style={{ ...palette, fontFamily: schema.referencePlan?.languageCalibration.fontFamily }}>
      <aside
        className={`ppt-thumbnails${renderedSlides?.length ? ' has-rendered-slides' : ''}`}
        aria-label="幻灯片缩略图"
      >
        {schema.slides.map((item, index) => {
          const thumbnail =
            renderedSlides?.find((rendered) => rendered.slideId === item.id)?.thumbnailUrl ??
            renderedSlides?.find((rendered) => rendered.slideId === item.id)?.url;
          return (
            <button
              type="button"
              key={item.id}
              className={index === active ? 'active' : ''}
              onClick={() => setActive(index)}
              aria-label={`第 ${index + 1} 页：${item.title || item.type}`}
            >
              {thumbnail ? (
                <img src={thumbnail} alt="" />
              ) : (
                <span>{String(index + 1).padStart(2, '0')}</span>
              )}
              <b>{item.title || item.type}</b>
            </button>
          );
        })}
      </aside>
      <div className="ppt-stage">
        <div className="ppt-toolbar">
          <span
            title={playing ? '按共享时间轴模拟，网页排版与 PowerPoint 可能有差异' : schema.title}
          >
            {schema.title}
            {playing ? ' · 动画预览' : ''}
          </span>
          <div>
            {schema.motionLanguage && (
              <>
                <button
                  className="ppt-motion-control"
                  type="button"
                  disabled={schema.motionLanguage.playback === 'none' || slide.motionDisabled}
                  onClick={() => {
                    setPlaying(true);
                    setReplay((value) => value + 1);
                  }}
                  title="播放本页共享时间轴"
                  aria-label={playing ? '重播动画' : '播放动画'}
                >
                  {playing ? <RotateCcw size={15} /> : <Play size={15} />}
                  {playing ? '重播' : '播放'}
                </button>
                {playing && maxClick > 0 && (
                  <button
                    className="ppt-motion-control"
                    type="button"
                    disabled={click >= maxClick}
                    onClick={() => setClick((value) => value + 1)}
                  >
                    下一步
                  </button>
                )}
                {playing && renderedSlide && (
                  <button
                    className="ppt-motion-control"
                    type="button"
                    onClick={() => setPlaying(false)}
                  >
                    静态实页
                  </button>
                )}
              </>
            )}
            <button
              type="button"
              onClick={() => setActive((value) => Math.max(0, value - 1))}
              disabled={active === 0}
              aria-label="上一页"
            >
              <ChevronLeft size={18} />
            </button>
            <span>
              {active + 1} / {schema.slides.length}
            </span>
            <button
              type="button"
              onClick={() => setActive((value) => Math.min(schema.slides.length - 1, value + 1))}
              disabled={active === schema.slides.length - 1}
              aria-label="下一页"
            >
              <ChevronRight size={18} />
            </button>
          </div>
        </div>
        <div className="ppt-stage-scroll" ref={stageRef}>
          <div
            ref={frameRef}
            className="ppt-slide-frame"
            style={{ width: slideWidth * scale, height: slideHeight * scale }}
          >
            <article
              className={`ppt-slide ppt-slide-${slide.type}${slide.layoutFamily ? ` ppt-family-${slide.layoutFamily}` : ''}${slide.layoutVariant ? ` ppt-variant-${slide.layoutVariant}` : ''}${photo && !photoIsBackground ? ' ppt-slide-has-image' : ''}${photoIsBackground ? ' ppt-photo-background' : ''}${showRendered ? ' ppt-slide-rendered' : ''}`}
              style={slideStyle}
            >
              {showRendered && renderedSlide ? (
                <img
                  className="ppt-rendered-image"
                  src={renderedSlide.url}
                  alt={`${schema.title} 第 ${active + 1} 页`}
                />
              ) : (
                <>
                  {photo && !photoIsBackground && slide.type === 'cover' && (
                    <img
                      data-motion-target="hero-image"
                      className="ppt-cover-image"
                      src={photo.url}
                      alt="与演示主题相关的图片"
                    />
                  )}
                  {photo && !photoIsBackground && slide.type === 'big-number' && (
                    <img
                      data-motion-target="product-image"
                      className="ppt-product-image"
                      src={photo.url}
                      alt="与数据主题相关的图片"
                    />
                  )}
                  {photo &&
                    !photoIsBackground &&
                    photo.imageRole === 'supporting' &&
                    ['title-content', 'summary'].includes(slide.type) && (
                      <img
                        data-motion-target="editorial-image"
                        className="ppt-supporting-image"
                        src={photo.url}
                        alt="与本页内容相关的图片"
                      />
                    )}
                  {slide.eyebrow && <span className="ppt-eyebrow">{slide.eyebrow}</span>}
                  {slide.slideRole === 'breath' && !['cover', 'full-image'].includes(slide.type) ? (
                    <h1 data-motion-target="statement" className="ppt-breath-statement">
                      {slide.keyMessage || slide.title}
                    </h1>
                  ) : (
                    <>
                      {slide.title && <h1 data-motion-target="headline">{slide.title}</h1>}
                      {(slide.subtitle ||
                        (['cover', 'section'].includes(slide.type) && slide.keyMessage)) && (
                        <p data-motion-target="subtitle" className="ppt-subtitle">
                          {['cover', 'section'].includes(slide.type)
                            ? slide.keyMessage || slide.subtitle
                            : slide.subtitle}
                        </p>
                      )}
                      <SlideBody slide={slide} colors={colors} photo={photo} />
                    </>
                  )}
                  {slide.sources?.length ? (
                    <footer>来源：{slide.sources.join(' · ')}</footer>
                  ) : null}
                  {photo && (
                    <span className="ppt-credit">
                      Photo by{' '}
                      <a href={photo.photoUrl} target="_blank" rel="noreferrer">
                        {photo.photographer}
                      </a>{' '}
                      on{' '}
                      <a href="https://www.pexels.com" target="_blank" rel="noreferrer">
                        Pexels
                      </a>
                    </span>
                  )}
                  <small className="ppt-page">{String(active + 1).padStart(2, '0')}</small>
                </>
              )}
            </article>
          </div>
        </div>
      </div>
    </div>
  );
}
