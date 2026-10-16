import qrcode from 'qrcode-generator';
import jsQR from 'jsqr';

// 暴露到 window 兼容外部测试或全局引用
if (typeof window !== 'undefined') {
  (window as unknown as { qrcode: typeof qrcode }).qrcode = qrcode;
  (window as unknown as { jsQR: typeof jsQR }).jsQR = jsQR;
}

export function renderQrToCanvas(canvas: HTMLCanvasElement, text: string): boolean {
  if (!canvas || !text) return false;
  try {
    const qr = qrcode(0, 'L');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();

    const targetSize = 360;
    const margin = 16;
    const available = targetSize - margin * 2;
    const cell = Math.max(1, Math.floor(available / count));
    const finalSize = cell * count + margin * 2;

    canvas.width = finalSize;
    canvas.height = finalSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, finalSize, finalSize);

    ctx.fillStyle = '#1c1917';
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) {
          ctx.fillRect(margin + c * cell, margin + r * cell, cell, cell);
        }
      }
    }
    return true;
  } catch (err) {
    console.error('QR 生成异常:', err);
    return false;
  }
}

export async function detectQrFromSource(
  source: HTMLCanvasElement | HTMLVideoElement | HTMLImageElement
): Promise<string | null> {
  if (!source) return null;

  // 1. 优先使用原生硬件加速 BarcodeDetector (Chrome 83+, Android Webview)
  const BarcodeDetectorClass = (window as unknown as { BarcodeDetector?: any }).BarcodeDetector;
  if (typeof BarcodeDetectorClass !== 'undefined') {
    try {
      const detector = new BarcodeDetectorClass({ formats: ['qr_code'] });
      const barcodes = await detector.detect(source);
      if (barcodes && barcodes.length > 0 && barcodes[0].rawValue) {
        return barcodes[0].rawValue;
      }
    } catch {
      // 降级到 jsQR
    }
  }

  // 2. jsQR 纯 JS 降级方案
  try {
    let width = 0;
    let height = 0;
    if (source instanceof HTMLVideoElement) {
      width = source.videoWidth;
      height = source.videoHeight;
    } else if (source instanceof HTMLImageElement) {
      width = source.naturalWidth || source.width;
      height = source.naturalHeight || source.height;
    } else if (source instanceof HTMLCanvasElement) {
      width = source.width;
      height = source.height;
    }

    if (!width || !height) return null;

    // 限制最大检测尺寸，防止超大相册图片卡顿
    const maxDimension = 1200;
    let scale = 1;
    if (width > maxDimension || height > maxDimension) {
      scale = maxDimension / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }

    const offscreen = document.createElement('canvas');
    offscreen.width = width;
    offscreen.height = height;
    const ctx = offscreen.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    ctx.drawImage(source, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    const result = jsQR(imageData.data, width, height, {
      inversionAttempts: 'attemptBoth',
    });

    return result ? result.data : null;
  } catch (err) {
    console.error('jsQR 识别异常:', err);
    return null;
  }
}
