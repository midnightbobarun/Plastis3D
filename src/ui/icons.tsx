// src/ui/icons.tsx — Plastis3D's own line icons (UI/UX redesign §4.5,
// PR32). Drawn for this repo (MIT); never taken from another product.
// 20 × 20 viewBox, 1.5 px stroke, round caps and joins, currentColor.
// Isometric line art for the 3D kinds; simple glyphs for actions.

import type { ReactElement, SVGProps } from "react";

export type IconName =
  | "box" | "sphere" | "cylinder" | "cone" | "torus" | "plane" | "capsule"
  | "group" | "sun" | "bulb" | "spot" | "camera" | "model" | "part" | "scene"
  | "select" | "move" | "rotate" | "scale" | "frame" | "home" | "grid"
  | "wireframe" | "eye" | "eyeOff" | "undo" | "redo" | "plus" | "search"
  | "check" | "chevron" | "caret" | "view" | "more" | "trash" | "duplicate"
  | "import" | "save" | "expand" | "sparkle" | "lock" | "reset" | "close"
  | "splat" | "palette" | "ruler" | "cube3" | "chat" | "image" | "warning" | "info";

const P = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const PATHS: Record<IconName, ReactElement> = {
  splat: <g {...P}><ellipse cx="10" cy="10" rx="7" ry="4" transform="rotate(-35 10 10)"/><circle cx="10" cy="10" r="1"/><path d="M3 4h.1M16 3h.1M17 15h.1M5 17h.1"/></g>,
  box: (
    <g {...P}>
      <path d="M10 2.8 16.6 6.4v7.2L10 17.2 3.4 13.6V6.4Z" />
      <path d="M3.4 6.4 10 10l6.6-3.6M10 10v7.2" />
    </g>
  ),
  sphere: (
    <g {...P}>
      <circle cx="10" cy="10" r="7" />
      <ellipse cx="10" cy="10" rx="7" ry="2.6" />
      <path d="M10 3c-2.2 2-2.2 12 0 14" opacity=".55" />
    </g>
  ),
  cylinder: (
    <g {...P}>
      <ellipse cx="10" cy="5" rx="5.6" ry="2.2" />
      <path d="M4.4 5v10c0 1.2 2.5 2.2 5.6 2.2s5.6-1 5.6-2.2V5" />
    </g>
  ),
  cone: (
    <g {...P}>
      <path d="M10 2.6 4.3 14.6M10 2.6l5.7 12" />
      <ellipse cx="10" cy="14.8" rx="5.7" ry="2.3" />
    </g>
  ),
  torus: (
    <g {...P}>
      <ellipse cx="10" cy="10.5" rx="7.2" ry="4.6" />
      <path d="M6.6 10.2c1.6 1.6 5.2 1.6 6.8 0M7.6 11.1c1.2-.9 3.6-.9 4.8 0" />
    </g>
  ),
  plane: (
    <g {...P}>
      <path d="M10 5.2 17.4 9.6 10 14 2.6 9.6Z" />
      <path d="M6.3 7.4 13.7 11.8M13.7 7.4 6.3 11.8" opacity=".45" />
    </g>
  ),
  capsule: (
    <g {...P}>
      <rect x="5.8" y="2.6" width="8.4" height="14.8" rx="4.2" />
      <path d="M5.8 8.2c1.2.9 7.2.9 8.4 0M5.8 11.8c1.2.9 7.2.9 8.4 0" opacity=".5" />
    </g>
  ),
  group: (
    <g {...P}>
      <path d="M2.8 6.2c0-.9.7-1.6 1.6-1.6h3.4l1.6 1.8h6.2c.9 0 1.6.7 1.6 1.6v6.4c0 .9-.7 1.6-1.6 1.6H4.4c-.9 0-1.6-.7-1.6-1.6Z" />
    </g>
  ),
  sun: (
    <g {...P}>
      <circle cx="10" cy="10" r="3.4" />
      <path d="M10 2.4v1.8M10 15.8v1.8M2.4 10h1.8M15.8 10h1.8M4.6 4.6l1.3 1.3M14.1 14.1l1.3 1.3M4.6 15.4l1.3-1.3M14.1 5.9l1.3-1.3" />
    </g>
  ),
  bulb: (
    <g {...P}>
      <path d="M7 12.6c-1.5-1-2.4-2.6-2.4-4.4a5.4 5.4 0 0 1 10.8 0c0 1.8-.9 3.4-2.4 4.4v1.6H7Z" />
      <path d="M7.6 16.6h4.8" />
    </g>
  ),
  spot: (
    <g {...P}>
      <path d="M7.2 2.8h5.6l-.8 3.4H8Z" />
      <path d="M8 6.2 4 16.4M12 6.2l4 10.2" opacity=".6" />
      <path d="M4 16.4c2 1 10 1 12 0" />
    </g>
  ),
  camera: (
    <g {...P}>
      <rect x="2.6" y="6" width="10.6" height="8.4" rx="1.6" />
      <path d="m13.2 8.8 4.2-2.2v7.2l-4.2-2.2" />
      <circle cx="6" cy="4.2" r="1.4" />
      <circle cx="10" cy="4.2" r="1.4" />
    </g>
  ),
  model: (
    <g {...P}>
      <path d="M10 2.8 16.6 6.4v7.2L10 17.2 3.4 13.6V6.4Z" />
      <path d="m3.4 6.4 6.6 3.6 6.6-3.6M10 10v7.2" />
      <path d="m6.7 4.6 6.6 3.6" opacity=".5" />
    </g>
  ),
  part: (
    <g {...P}>
      <path d="M10 5.4 14.4 8v5.2L10 15.8l-4.4-2.6V8Z" />
      <path d="m5.6 8 4.4 2.6L14.4 8M10 10.6v5.2" />
      <path d="M3 4.6V3h1.6M17 4.6V3h-1.6M3 15.4V17h1.6M17 15.4V17h-1.6" opacity=".55" />
    </g>
  ),
  scene: (
    <g {...P}>
      <path d="M10 2.8 16.6 6.4v7.2L10 17.2 3.4 13.6V6.4Z" />
      <circle cx="10" cy="10" r="1.6" />
    </g>
  ),
  select: (
    <g {...P}>
      <path d="m4.6 3.4 10.2 5.4-4.4 1.4-1.6 4.6Z" />
      <path d="m10.4 10.2 3.8 4.2" />
    </g>
  ),
  move: (
    <g {...P}>
      <path d="M10 2.6v14.8M2.6 10h14.8" />
      <path d="m7.8 4.8 2.2-2.2 2.2 2.2M7.8 15.2l2.2 2.2 2.2-2.2M4.8 7.8 2.6 10l2.2 2.2M15.2 7.8l2.2 2.2-2.2 2.2" />
    </g>
  ),
  rotate: (
    <g {...P}>
      <path d="M16.4 10a6.4 6.4 0 1 1-2-4.6" />
      <path d="M14.8 2.6v3h-3" />
    </g>
  ),
  scale: (
    <g {...P}>
      <rect x="2.8" y="9.6" width="7.6" height="7.6" rx="1" />
      <path d="M8.4 3h8.6v8.6" strokeDasharray="2 2" />
      <path d="m9.6 10.4 6-6M12.6 4.4h3v3" />
    </g>
  ),
  frame: (
    <g {...P}>
      <path d="M3 7V4.2C3 3.5 3.5 3 4.2 3H7M13 3h2.8c.7 0 1.2.5 1.2 1.2V7M17 13v2.8c0 .7-.5 1.2-1.2 1.2H13M7 17H4.2c-.7 0-1.2-.5-1.2-1.2V13" />
      <circle cx="10" cy="10" r="2.6" />
    </g>
  ),
  home: (
    <g {...P}>
      <path d="M3.4 9 10 3.4 16.6 9" />
      <path d="M5.2 7.6v8.2h9.6V7.6" />
    </g>
  ),
  grid: (
    <g {...P}>
      <path d="M10 4.6 17 8.4 10 12.2 3 8.4Z" />
      <path d="m6.5 6.5 7 3.8M13.5 6.5l-7 3.8" opacity=".6" />
      <path d="M3 12 10 15.8 17 12" opacity=".5" />
    </g>
  ),
  wireframe: (
    <g {...P}>
      <path d="M10 2.8 16.6 6.4v7.2L10 17.2 3.4 13.6V6.4Z" />
      <path d="M3.4 6.4 16.6 13.6M16.6 6.4 3.4 13.6M10 2.8v14.4" opacity=".55" />
    </g>
  ),
  eye: (
    <g {...P}>
      <path d="M1.8 10S4.8 4.6 10 4.6 18.2 10 18.2 10 15.2 15.4 10 15.4 1.8 10 1.8 10Z" />
      <circle cx="10" cy="10" r="2.4" />
    </g>
  ),
  eyeOff: (
    <g {...P}>
      <path d="M4.2 6.2C2.6 7.7 1.8 10 1.8 10s3 5.4 8.2 5.4c1.5 0 2.8-.4 3.9-1M8 4.8c.6-.1 1.3-.2 2-.2 5.2 0 8.2 5.4 8.2 5.4s-.7 1.3-2 2.7" />
      <path d="m3 3 14 14" />
    </g>
  ),
  undo: (
    <g {...P}>
      <path d="M5.4 8.2h7a4 4 0 0 1 0 8H9" />
      <path d="M8.2 5 5 8.2l3.2 3.2" />
    </g>
  ),
  redo: (
    <g {...P}>
      <path d="M14.6 8.2h-7a4 4 0 0 0 0 8H11" />
      <path d="M11.8 5 15 8.2l-3.2 3.2" />
    </g>
  ),
  plus: <path {...P} d="M10 4v12M4 10h12" />,
  search: (
    <g {...P}>
      <circle cx="8.8" cy="8.8" r="5" />
      <path d="m12.6 12.6 4 4" />
    </g>
  ),
  check: <path {...P} d="m4.4 10.4 3.6 3.6 7.6-7.8" />,
  chevron: <path {...P} d="m6 8 4 4 4-4" />,
  caret: <path d="M6.5 8h7L10 12.5Z" fill="currentColor" />,
  view: (
    <g {...P}>
      <path d="M3 5.4h8M15 5.4h2M3 10h3M10 10h7M3 14.6h9M16 14.6h1" />
      <circle cx="13" cy="5.4" r="1.8" />
      <circle cx="8" cy="10" r="1.8" />
      <circle cx="14" cy="14.6" r="1.8" />
    </g>
  ),
  more: (
    <g fill="currentColor">
      <circle cx="5" cy="10" r="1.4" />
      <circle cx="10" cy="10" r="1.4" />
      <circle cx="15" cy="10" r="1.4" />
    </g>
  ),
  trash: (
    <g {...P}>
      <path d="M3.6 5.6h12.8M8 5.6V3.8h4v1.8M5.2 5.6l.8 10.6c.1.7.6 1.2 1.3 1.2h5.4c.7 0 1.2-.5 1.3-1.2l.8-10.6" />
    </g>
  ),
  duplicate: (
    <g {...P}>
      <rect x="6.6" y="6.6" width="10" height="10" rx="1.8" />
      <path d="M13.4 6.6V4.8c0-1-.8-1.8-1.8-1.8H4.8c-1 0-1.8.8-1.8 1.8v6.8c0 1 .8 1.8 1.8 1.8h1.8" />
    </g>
  ),
  import: (
    <g {...P}>
      <path d="M2.8 15.8V5.2c0-.9.7-1.6 1.6-1.6h3.7l1.7 1.8h5.8c.9 0 1.6.7 1.6 1.6v1" />
      <path d="M2.8 15.8 5 9.1h12.2l-2.1 6.7c-.2.6-.8 1-1.4 1H4.2c-.7 0-1.2-.4-1.4-1Z" />
    </g>
  ),
  save: (
    <g {...P}>
      <path d="M4.4 2.8h9.8l3 3v9.8c0 .9-.7 1.6-1.6 1.6H4.4c-.9 0-1.6-.7-1.6-1.6V4.4c0-.9.7-1.6 1.6-1.6Z" />
      <path d="M6 2.8v4.6h7V2.8M6 17.2v-6.6h8v6.6" />
    </g>
  ),
  expand: (
    <g {...P}>
      <path d="M11.6 3h5.4v5.4M17 3l-6.2 6.2M8.4 17H3v-5.4M3 17l6.2-6.2" />
    </g>
  ),
  sparkle: (
    <g {...P}>
      <path d="M10 2.6c.6 3.6 1.8 4.8 5.4 5.4-3.6.6-4.8 1.8-5.4 5.4-.6-3.6-1.8-4.8-5.4-5.4 3.6-.6 4.8-1.8 5.4-5.4Z" />
      <path d="M15.4 13.2c.2 1.4.7 1.9 2.1 2.1-1.4.2-1.9.7-2.1 2.1-.2-1.4-.7-1.9-2.1-2.1 1.4-.2 1.9-.7 2.1-2.1Z" />
    </g>
  ),
  lock: (
    <g {...P}>
      <rect x="4.2" y="8.6" width="11.6" height="8.4" rx="1.8" />
      <path d="M6.8 8.6V6.4a3.2 3.2 0 0 1 6.4 0v2.2" />
    </g>
  ),
  reset: (
    <g {...P}>
      <path d="M4 10a6 6 0 1 0 1.8-4.3" />
      <path d="M4.4 2.8v3.4h3.4" />
    </g>
  ),
  close: <path {...P} d="m5 5 10 10M15 5 5 15" />,
  warning: (
    <g {...P}>
      <path d="M10 3.4 17.2 16H2.8L10 3.4Z" />
      <path d="M10 8.2v3.6" />
      <circle cx="10" cy="14" r=".6" fill="currentColor" />
    </g>
  ),
  info: (
    <g {...P}>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 9.2v4.2" />
      <circle cx="10" cy="6.7" r=".6" fill="currentColor" />
    </g>
  ),
  image: (
    <g {...P}>
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <circle cx="7.5" cy="8.2" r="1.3" />
      <path d="m3.6 14.6 4-3.8 3 2.6 2.2-2 3.6 3.6" />
    </g>
  ),
  palette: (
    <g {...P}>
      <path d="M10 2.8a7.2 7.2 0 0 0 0 14.4c1 0 1.6-.6 1.6-1.4 0-1.2-1-1.4-1-2.4 0-.9.7-1.5 1.6-1.5h1.9c2.1 0 3.9-1.7 3.9-3.9 0-2.9-3.6-5.2-8-5.2Z" />
      <circle cx="6.4" cy="9.4" r="1" fill="currentColor" />
      <circle cx="8.6" cy="6" r="1" fill="currentColor" />
      <circle cx="12.6" cy="6.2" r="1" fill="currentColor" />
    </g>
  ),
  ruler: (
    <g {...P}>
      <path d="m3 13.6 10.6-10.6 3.4 3.4L6.4 17Z" />
      <path d="m6.2 10.4 1.6 1.6M8.6 8l1.2 1.2M11 5.6l1.6 1.6" />
    </g>
  ),
  cube3: (
    <g {...P}>
      <path d="M10 2.8 16.6 6.4v7.2L10 17.2 3.4 13.6V6.4Z" />
      <path d="M3.4 6.4 10 10l6.6-3.6M10 10v7.2" />
    </g>
  ),
  chat: (
    <g {...P}>
      <path d="M3.4 5.4c0-1.1.9-2 2-2h9.2c1.1 0 2 .9 2 2v6.2c0 1.1-.9 2-2 2H9l-3.6 3v-3h0c-1.1 0-2-.9-2-2Z" />
    </g>
  ),
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  size?: number;
}

/** One of Plastis3D's own icons, decorative by default (aria-hidden). */
export function Icon({ name, size = 18, ...rest }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}

/** The icon for a scene node, from its kind (and primitive type / light type). */
export function nodeIconName(node: {
  kind: string;
  primitive?: { type: string } | null;
  light?: { type: string } | null;
}): IconName {
  switch (node.kind) {
    case "splat": return "splat";
    case "mesh": {
      const t = node.primitive?.type;
      if (t && t in PATHS) return t as IconName;
      return "box";
    }
    case "light":
      return node.light?.type === "point"
        ? "bulb"
        : node.light?.type === "spot"
          ? "spot"
          : "sun";
    case "camera":
      return "camera";
    case "group":
      return "group";
    case "model":
      return "model";
    case "part":
      return "part";
    default:
      return "cube3";
  }
}
