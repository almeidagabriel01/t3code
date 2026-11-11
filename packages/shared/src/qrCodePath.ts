import { QrCode } from "./qrCode.ts";

const ERROR_CORRECTION_LEVELS = {
  L: QrCode.Ecc.LOW,
  M: QrCode.Ecc.MEDIUM,
  Q: QrCode.Ecc.QUARTILE,
  H: QrCode.Ecc.HIGH,
} as const;

/** A QR code as one SVG path of dark runs, inside a square of `size` modules with the margin. */
export function qrCodePath(
  value: string,
  level: keyof typeof ERROR_CORRECTION_LEVELS,
  marginSize: number,
): { readonly size: number; readonly path: string } {
  const qrCode = QrCode.encodeText(value, ERROR_CORRECTION_LEVELS[level]);
  const commands: Array<string> = [];
  for (let y = 0; y < qrCode.size; y += 1) {
    let runStart = -1;
    for (let x = 0; x <= qrCode.size; x += 1) {
      if (x < qrCode.size && qrCode.getModule(x, y)) {
        if (runStart === -1) runStart = x;
        continue;
      }
      if (runStart === -1) continue;
      commands.push(
        `M${runStart + marginSize} ${y + marginSize}h${x - runStart}v1H${runStart + marginSize}z`,
      );
      runStart = -1;
    }
  }
  return { size: qrCode.size + marginSize * 2, path: commands.join("") };
}
