import { useId, type SVGProps } from "react";

export function BrowneBMark(props: SVGProps<SVGSVGElement>) {
  const sparkGradientId = useId();
  return (
    <svg {...props} viewBox="30 22 64.5 84" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient
          id={sparkGradientId}
          x1="30"
          y1="57.2"
          x2="64"
          y2="67.2"
          gradientUnits="userSpaceOnUse"
        >
          {/* oxlint-disable-next-line shadcn/no-raw-colors -- Browne brand copper gradient */}
          <stop offset="0" stopColor="#F19B58" />
          {/* oxlint-disable-next-line shadcn/no-raw-colors -- Browne brand copper gradient */}
          <stop offset="1" stopColor="#CC6C2D" />
        </linearGradient>
      </defs>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M 35.5 22 L 67 22 C 79.8 22 89 30.2 89 41.2 C 89 49.6 84.4 55.8 76.2 58.8 C 87.2 61.5 94.5 70.2 94.5 82.8 C 94.5 96.8 84.5 106 68.5 106 L 35.5 106 C 33.4 106 32 104.6 32 102.5 L 32 69.8 L 62.5 69.8 C 65.5 69.8 67.5 67.8 67.5 64.8 L 67.5 59.7 C 67.5 56.7 65.5 54.7 62.5 54.7 L 32 54.7 L 32 25.5 C 32 23.4 33.4 22 35.5 22 Z M 45.5 34 L 45.5 54.7 L 66 54.7 C 72.2 54.7 76 50.8 76 44.3 C 76 37.8 72.2 34 66 34 L 45.5 34 Z M 45.5 69.8 L 45.5 93.8 L 68.5 93.8 C 76.2 93.8 81 88.9 81 81.8 C 81 74.6 76.2 69.8 68.5 69.8 L 45.5 69.8 Z"
        fill="currentColor"
      />
      <rect x="30" y="57.2" width="34.2" height="10" rx="2.6" fill={`url(#${sparkGradientId})`} />
    </svg>
  );
}
