import { memo } from "react";
import { qrCodePath } from "@t3tools/shared/qrCodePath";

type QRCodeSvgProps = {
  value: string;
  size?: number;
  level?: "L" | "M" | "Q" | "H";
  marginSize?: number;
  title?: string;
  className?: string;
  foregroundColor?: string;
  backgroundColor?: string;
};

export const QRCodeSvg = memo(function QRCodeSvg({
  value,
  size = 128,
  level = "L",
  marginSize = 0,
  title,
  className,
  foregroundColor = "#000",
  backgroundColor = "#fff",
}: QRCodeSvgProps) {
  const { size: viewBoxSize, path } = qrCodePath(value, level, marginSize);

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      role={title ? "img" : undefined}
      aria-label={title}
      className={className}
    >
      {title ? <title>{title}</title> : null}
      <rect width={viewBoxSize} height={viewBoxSize} fill={backgroundColor} />
      <path d={path} fill={foregroundColor} />
    </svg>
  );
});
