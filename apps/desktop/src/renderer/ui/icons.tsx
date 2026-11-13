import type { CSSProperties } from 'react';

/** Zeyvola's own icon set: 20 px grid, 1.5 px strokes, round caps and joins. */
const STROKE: Record<string, string> = {
  screen: 'M4.5 3.5h11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM7 16.5h6M10 13.5v3',
  window: 'M4.5 4h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM2.5 7.5h15',
  region: 'M3 7V4.5A1.5 1.5 0 0 1 4.5 3H7M13 3h2.5A1.5 1.5 0 0 1 17 4.5V7M17 13v2.5a1.5 1.5 0 0 1-1.5 1.5H13M7 17H4.5A1.5 1.5 0 0 1 3 15.5V13M10 8v4M8 10h4',
  camera: 'M4.5 5.5h6.5a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H4.5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2zM13 9l4.5-2.5v7L13 11',
  mic: 'M10 2.5a2.5 2.5 0 0 1 2.5 2.5v4a2.5 2.5 0 0 1-5 0V5A2.5 2.5 0 0 1 10 2.5zM4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5',
  speaker: 'M3.5 8h3l4-3.5v11l-4-3.5h-3zM13.5 7.5a3.5 3.5 0 0 1 0 5M15.5 5.5a6.5 6.5 0 0 1 0 9',
  back: 'M12 4.5L6.5 10l5.5 5.5',
  undo: 'M7.5 5L4 8.5 7.5 12M4 8.5h7.5a4.5 4.5 0 0 1 0 9H9',
  redo: 'M12.5 5L16 8.5 12.5 12M16 8.5H8.5a4.5 4.5 0 0 0 0 9H11',
  zoom: 'M9 3.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM13 13l4 4M9 6.5v5M6.5 9h5',
  magnifier: 'M8.5 2.5a6 6 0 1 1 0 12 6 6 0 0 1 0-12zM12.8 12.8l4.2 4.2M7 6v5.2l1.4-1.2 1 2.1 1-.5-1-2h1.8z',
  privacy: 'M2.5 10s3-5.5 7.5-5.5S17.5 10 17.5 10s-3 5.5-7.5 5.5S2.5 10 2.5 10zM10 7.8a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4zM4 16L16 4',
  eye: 'M2.5 10s3-5.5 7.5-5.5S17.5 10 17.5 10s-3 5.5-7.5 5.5S2.5 10 2.5 10zM10 7.8a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4z',
  layout: 'M4.5 3.5h11a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2zM13.5 10.3a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4z',
  cursor: 'M5 3.5v12l3.3-3 2.3 4.8 2-1-2.3-4.7h4.2z',
  brush: 'M15.5 3l1.5 1.5-7 7.5-1.5-1.5zM8.5 10.5c-1.8-.3-3.3.8-3.5 2.6-.1 1.1-.6 2.2-2 2.9 2.8 1.2 6.5.6 7.2-2.3',
  export: 'M10 3v10M6 7l4-4 4 4M4 13v2.5A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5V13',
  folder: 'M2.5 6A1.5 1.5 0 0 1 4 4.5h3.5l2 2H16A1.5 1.5 0 0 1 17.5 8v6.5A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5z',
  trash: 'M4 6h12M8 6V4.5h4V6M5.5 6l.8 9.5a1.5 1.5 0 0 0 1.5 1.4h4.4a1.5 1.5 0 0 0 1.5-1.4L14.5 6',
  plus: 'M10 4v12M4 10h12',
  close: 'M5 5l10 10M15 5L5 15',
  check: 'M4.5 10.5l3.5 3.5 7.5-8',
  split: 'M10 2.5v15M7.5 2.5h5L10 5zM7.5 17.5h5L10 15z',
  marker: 'M5 17V3.5M5 4h9l-2 3 2 3H5',
  sliders: 'M4 6h7M15 6h1M13 4a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM4 14h1M9 14h7M7 12a2 2 0 1 1 0 4 2 2 0 0 1 0-4z',
  sparkle: 'M10 3l1.6 4.4L16 9l-4.4 1.6L10 15l-1.6-4.4L4 9l4.4-1.6zM15.5 13.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z',
  chevronDown: 'M5.5 8l4.5 4.5L14.5 8',
  chevronRight: 'M8 5.5l4.5 4.5L8 14.5',
  info: 'M10 3a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM10 9v4.5M10 6.5v.01',
  warning: 'M10 3.5l7 12.5H3zM10 8.5v3.5M10 14v.01',
  refresh: 'M15.5 8A6 6 0 1 0 16 11.5M16 4v4h-4',
  shield: 'M10 2.8l6 2.2v4.6c0 3.7-2.6 6.4-6 7.6-3.4-1.2-6-3.9-6-7.6V5z',
  film: 'M4.5 3.5h11a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2zM6 3.5v13M14 3.5v13M2.5 8h3.5M2.5 12h3.5M14 8h3.5M14 12h3.5',
  scissors: 'M6 4.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM6 11.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM7.6 8l9.4 6.5M7.6 12L17 5.5',
};

const FILL: Record<string, string> = {
  record: 'M10 4.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11z',
  play: 'M6.5 4.3c0-.6.7-1 1.2-.7l8.4 5.4c.5.3.5 1.1 0 1.4l-8.4 5.4c-.5.3-1.2-.1-1.2-.7z',
  pause: 'M6 4.5h2a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM12 4.5h2a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z',
  stop: 'M6.5 5h7A1.5 1.5 0 0 1 15 6.5v7a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 5 13.5v-7A1.5 1.5 0 0 1 6.5 5z',
  more: 'M5 8.8a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4zM10 8.8a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4zM15 8.8a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4z',
};

export type IconName = keyof typeof STROKE | keyof typeof FILL;

export function Icon({ name, size = 18, style, className }: { name: IconName; size?: number; style?: CSSProperties; className?: string }) {
  const fill = FILL[name];
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" className={className} style={style}>
      {fill
        ? <path d={fill} fill="currentColor" />
        : <path d={STROKE[name]} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

/** Brand mark: a stage (screen) with the camera bubble resting on it. */
export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2.5" y="4" width="19" height="13.5" rx="3.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="17.3" cy="16.6" r="4.4" fill="var(--accent)" stroke="var(--bg-app)" strokeWidth="1.6" />
    </svg>
  );
}
