import type { ReactNode, SVGProps } from "react";

/**
 * Small stroke icon set (24×24 grid, currentColor) for dense settings UI.
 * Decorative by default (aria-hidden); the visible label carries the meaning.
 */
function Svg({ children, size = 16, ...rest }: SVGProps<SVGSVGElement> & { size?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

type P = { size?: number; className?: string };

export const KeyIcon = (p: P) => (
  <Svg {...p}><circle cx="7.5" cy="15.5" r="5.5" /><path d="m21 2-9.6 9.6" /><path d="m15.5 7.5 3 3L22 7l-3-3" /></Svg>
);
export const BoltIcon = (p: P) => (
  <Svg {...p}><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" /></Svg>
);
export const SparklesIcon = (p: P) => (
  <Svg {...p}><path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" /><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z" /></Svg>
);
export const WandIcon = (p: P) => (
  <Svg {...p}><path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8 19 13M17.8 6.2 19 5M3 21l9-9M12.2 6.2 11 5" /></Svg>
);
export const BuildingIcon = (p: P) => (
  <Svg {...p}><rect x="4" y="2" width="16" height="20" rx="1" /><path d="M9 22v-4h6v4M8 6h.01M12 6h.01M16 6h.01M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01" /></Svg>
);
export const LayersIcon = (p: P) => (
  <Svg {...p}><path d="m12 2 10 5-10 5L2 7l10-5z" /><path d="m2 12 10 5 10-5" /><path d="m2 17 10 5 10-5" /></Svg>
);
export const TagIcon = (p: P) => (
  <Svg {...p}><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z" /><circle cx="7" cy="7" r="1" /></Svg>
);
export const GaugeIcon = (p: P) => (
  <Svg {...p}><path d="m12 14 4-4" /><path d="M3.3 19a10 10 0 1 1 17.4 0" /></Svg>
);
export const SlidersIcon = (p: P) => (
  <Svg {...p}><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" /></Svg>
);
export const CoinsIcon = (p: P) => (
  <Svg {...p}><circle cx="8" cy="8" r="6" /><path d="M18.1 10.4A6 6 0 1 1 10.4 18.1" /><path d="M7 6h1v4" /></Svg>
);
export const CheckIcon = (p: P) => (
  <Svg {...p}><path d="M20 6 9 17l-5-5" /></Svg>
);
export const XIcon = (p: P) => (
  <Svg {...p}><path d="M18 6 6 18M6 6l12 12" /></Svg>
);
export const AlertIcon = (p: P) => (
  <Svg {...p}><circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" /></Svg>
);
export const InfoIcon = (p: P) => (
  <Svg {...p}><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></Svg>
);
export const ResetIcon = (p: P) => (
  <Svg {...p}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></Svg>
);
export const PencilIcon = (p: P) => (
  <Svg {...p}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" /></Svg>
);
export const SearchIcon = (p: P) => (
  <Svg {...p}><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></Svg>
);
export const GlobeIcon = (p: P) => (
  <Svg {...p}><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" /></Svg>
);
export const TargetIcon = (p: P) => (
  <Svg {...p}><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" /></Svg>
);
export const LinkIcon = (p: P) => (
  <Svg {...p}><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></Svg>
);
export const EyeIcon = (p: P) => (
  <Svg {...p}><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></Svg>
);
export const FilterIcon = (p: P) => (
  <Svg {...p}><path d="M22 3H2l8 9.5V19l4 2v-8.5L22 3z" /></Svg>
);
export const CalendarIcon = (p: P) => (
  <Svg {...p}><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></Svg>
);
export const ActivityIcon = (p: P) => (
  <Svg {...p}><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></Svg>
);
export const ClockIcon = (p: P) => (
  <Svg {...p}><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></Svg>
);
export const SendIcon = (p: P) => (
  <Svg {...p}><path d="m22 2-7 20-4-9-9-4 20-7z" /><path d="M22 2 11 13" /></Svg>
);
export const MailIcon = (p: P) => (
  <Svg {...p}><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-10 6L2 7" /></Svg>
);

export const ExternalLinkIcon = (p: P) => (
  <Svg {...p}><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></Svg>
);
