type BrandMarkProps = {
  /** Display size in CSS pixels. */
  size?: number;
  className?: string;
  /** Empty when decorative next to visible brand text. */
  alt?: string;
};

/**
 * App mark: plate + G monogram.
 * Colors via --brand-mark-bg / --brand-mark-fg (invert in dark theme).
 * Inline SVG so every display size (incl. retina) stays anti-aliased/smooth.
 */
export function BrandMark({
  size = 24,
  className,
  alt = "",
}: BrandMarkProps) {
  const labelled = Boolean(alt);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 1024 1024"
      width={size}
      height={size}
      className={className}
      role={labelled ? "img" : undefined}
      aria-label={labelled ? alt : undefined}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
      shapeRendering="geometricPrecision"
    >
      <rect width="1024" height="1024" fill="var(--brand-mark-bg, #000)" />
      <path
        fill="var(--brand-mark-fg, #fff)"
        fillRule="evenodd"
        d="M756.119 668.717A268 268 0 1 1 756.119 357.283L662.523 424.102A153 153 0 1 0 662.523 601.898ZM513 502H833V525H513Z"
      />
    </svg>
  );
}
