import type { PresentationMotionCue, PresentationTransition } from '../../types.ts';

/** No choreography here: timings, ordering and targets come from the snapshot. */
export function motionFrames(
  cue: PresentationMotionCue,
  accent: string,
  canvas = { width: 1280, height: 720 },
): Keyframe[] {
  // Match PPTX's fraction of the slide, not a percentage of each target's size.
  const fraction = { micro: 0.012, short: 0.025, medium: 0.045 }[cue.distance];
  const horizontal = cue.direction === 'left' || cue.direction === 'right';
  const offset =
    fraction *
    (horizontal ? canvas.width : canvas.height) *
    (cue.direction === 'down' || cue.direction === 'right' ? -1 : 1);
  const movement = horizontal ? `translateX(${offset}px)` : `translateY(${offset}px)`;
  switch (cue.effect) {
    case 'rise':
      return [
        { opacity: 0, transform: movement },
        { opacity: 1, transform: 'translate(0)' },
      ];
    case 'fly':
      return [
        { opacity: 1, transform: movement },
        { opacity: 1, transform: 'translate(0)' },
      ];
    case 'zoom':
      return [
        { opacity: 0, transform: 'scale(.97)' },
        { opacity: 1, transform: 'scale(1)' },
      ];
    case 'wipe': {
      const clip = {
        up: 'inset(100% 0 0 0)',
        down: 'inset(0 0 100% 0)',
        left: 'inset(0 100% 0 0)',
        right: 'inset(0 0 0 100%)',
      }[cue.direction];
      return [
        { opacity: 1, clipPath: clip },
        { opacity: 1, clipPath: 'inset(0 0 0 0)' },
      ];
    }
    case 'grow':
    case 'pulse':
      return [
        { transform: 'scale(1)' },
        { transform: cue.effect === 'grow' ? 'scale(1.04)' : 'scale(1.06)', offset: 0.5 },
        { transform: 'scale(1)' },
      ];
    case 'colorEmphasis':
      return [{}, { color: accent, offset: 0.5 }, {}];
    case 'fadeOut':
      return [{ opacity: 1 }, { opacity: 0 }];
    case 'appear':
      return [{ opacity: 0 }, { opacity: 1, offset: 0.001 }, { opacity: 1 }];
    case 'none':
      return [];
    default:
      return [{ opacity: 0 }, { opacity: 1 }];
  }
}

export function transitionFrames(spec?: PresentationTransition | null): Keyframe[] {
  if (!spec || spec.effect === 'none') return [];
  if (spec.effect === 'push') {
    const offset = spec.direction === 'left' || spec.direction === 'up' ? 6 : -6;
    return [
      {
        opacity: 0,
        transform:
          spec.direction === 'left' || spec.direction === 'right'
            ? `translateX(${offset}%)`
            : `translateY(${offset}%)`,
      },
      { opacity: 1, transform: 'translate(0)' },
    ];
  }
  if (spec.effect === 'wipe')
    return motionFrames({ effect: 'wipe', direction: spec.direction } as PresentationMotionCue, '');
  return [{ opacity: 0 }, { opacity: 1 }];
}

export function segmentCues(
  timeline: PresentationMotionCue[] | null | undefined,
  clickIndex: number,
) {
  return (timeline ?? [])
    .filter((cue) => cue.clickIndex === clickIndex && cue.effect !== 'none')
    .sort((a, b) => a.order - b.order);
}

export function playMotion(
  root: HTMLElement,
  timeline: PresentationMotionCue[],
  clickIndex: number,
  accent: string,
  transition?: PresentationTransition | null,
  reduceMotion = false,
): () => void {
  const animations: Animation[] = [];
  const slide = root.querySelector?.<HTMLElement>('.ppt-slide');
  const canvas = { width: slide?.offsetWidth || 1280, height: slide?.offsetHeight || 720 };
  const targets = new Map<string, HTMLElement>();
  root
    .querySelectorAll<HTMLElement>('[data-motion-target]')
    .forEach((node) => targets.set(node.dataset.motionTarget!, node));
  if (reduceMotion || typeof root.animate !== 'function') return () => {};
  if (clickIndex === 0) {
    // Future click entrances must remain hidden, but emphasis/exit targets stay visible.
    const first = new Map<string, PresentationMotionCue>();
    for (const cue of timeline) if (!first.has(cue.target)) first.set(cue.target, cue);
    for (const cue of first.values()) {
      if (
        cue.clickIndex > 0 &&
        !['grow', 'pulse', 'colorEmphasis', 'fadeOut', 'none'].includes(cue.effect)
      ) {
        const target = targets.get(cue.target);
        if (target)
          animations.push(
            target.animate([{ opacity: 0 }, { opacity: 0 }], { duration: 1, fill: 'both' }),
          );
      }
    }
    const frames = transitionFrames(transition);
    if (frames.length)
      animations.push(
        root.animate(frames, {
          duration: (transition?.duration ?? 0.42) * 1000,
          easing: 'ease-out',
          fill: 'backwards',
        }),
      );
  }
  for (const cue of segmentCues(timeline, clickIndex)) {
    const target = targets.get(cue.target);
    if (!target) continue;
    const frames = motionFrames(cue, accent, canvas);
    if (frames.length)
      animations.push(
        target.animate(frames, {
          delay: cue.start * 1000,
          duration: cue.duration * 1000,
          easing: cue.effect === 'appear' ? 'linear' : 'cubic-bezier(.22,.61,.36,1)',
          fill: 'both',
        }),
      );
  }
  return () => animations.forEach((animation) => animation.cancel());
}
