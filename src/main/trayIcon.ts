import { nativeImage, type NativeImage } from 'electron'

/** Five rounded waveform bars as a macOS template image, drawn at 2x for Retina. */
export function trayIcon(): NativeImage {
  const size = 36
  const pixels = Buffer.alloc(size * size * 4)
  const bars = [10, 18, 26, 18, 10]
  const barWidth = 4
  const gap = 2.5
  const totalWidth = bars.length * barWidth + (bars.length - 1) * gap
  const left = (size - totalWidth) / 2

  bars.forEach((height, i) => {
    const x0 = left + i * (barWidth + gap)
    const y0 = (size - height) / 2
    const radius = barWidth / 2
    for (let y = Math.floor(y0); y < Math.ceil(y0 + height); y++) {
      for (let x = Math.floor(x0); x < Math.ceil(x0 + barWidth); x++) {
        const cx = x + 0.5
        const cy = Math.min(Math.max(y + 0.5, y0 + radius), y0 + height - radius)
        const distance = Math.hypot(cx - (x0 + radius), y + 0.5 - cy)
        const alpha = Math.max(0, Math.min(1, radius + 0.5 - distance))
        if (alpha === 0) continue
        const offset = (y * size + x) * 4
        pixels[offset + 3] = Math.round(alpha * 255)
      }
    }
  })

  const image = nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 2 })
  image.setTemplateImage(true)
  return image
}
