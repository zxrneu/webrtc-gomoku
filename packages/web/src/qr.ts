/**
 * 二维码生成与扫码图像识别模块（QR Code Generation & Detection）
 *
 * 【为什么需要这个模块？—— 小白科普】：
 * 在没有中央信令服务器的“纯手动无网模式”下，玩家需要交换 WebRTC 的连接码。
 * 如果只靠复制粘贴文本，在手机端操作非常繁琐且容易漏选字符。
 *
 * 本模块提供两大核心能力：
 * 1. 【出码】renderQrToCanvas：把压缩后的连接码绘制在 Canvas 画布上，生成清晰的高对比度二维码；
 * 2. 【扫码】detectQrFromSource：支持手机摄像头实时取景扫描，也支持用户从相册上传二维码截图识别。
 *    采用“原生硬件加速 API (BarcodeDetector) 优先 + 纯 JS (jsQR) 兜底”的双层识别流水线！
 */

import qrcode from 'qrcode-generator';
import jsQR from 'jsqr';

// 暴露到 window 对象，方便 Playwright 自动化 E2E 测试及控制台排查
if (typeof window !== 'undefined') {
  (window as unknown as { qrcode: typeof qrcode }).qrcode = qrcode;
  (window as unknown as { jsQR: typeof jsQR }).jsQR = jsQR;
}

/**
 * 将任意文本内容渲染为高质量二维码到指定的 HTML5 `<canvas>` 画布上
 *
 * 【图形学与二维码设计要点】：
 * 1. 为什么用 Level 'L' 纠错？
 *    五子棋的 SDP 连接码有几百个字符，数据量较大。
 *    'L' 级别（7% 容错率）所需要的点阵格子最少、密度最小，在手机屏幕上更容易被对端扫出！
 * 2. 像素整数化对齐（Cell Snap）：
 *    如果格子宽度算出来是带小数的（如 3.7px），Canvas 绘制会出现模糊边缘（抗锯齿毛刺）。
 *    通过 `Math.floor(available / count)` 取整，确保每个黑白格子都锐利清晰。
 * 3. 留白保护区（Quiet Zone）：
 *    二维码四周必须留出 16px 纯白边距，这是国际二维码标准规范，没有留白手机摄像头将无法定焦识别。
 *
 * @param canvas 目标 Canvas DOM 元素
 * @param text 需要编码的文本字符串（通常为 'Z' 开头的连接码）
 * @returns 绘制成功返回 true，失败返回 false
 */
export function renderQrToCanvas(canvas: HTMLCanvasElement, text: string): boolean {
  if (!canvas || !text) return false;
  try {
    // 0 表示自动根据文本长度选择最小的 QR Version（版本 1~40）
    // 'L' 表示低纠错级别 (Low, 7%)，换取最大的数据容量
    const qr = qrcode(0, 'L');
    qr.addData(text);
    qr.make();
    // 获取点阵模块数量（即 count × count 的格子方阵，例如 45x45）
    const count = qr.getModuleCount();

    const targetSize = 360; // 目标画布基准尺寸（像素）
    const margin = 16;     // 四周留白（Quiet Zone）
    const available = targetSize - margin * 2;
    // 计算每个黑白小方块的像素边长（向下取整避免模糊）
    const cell = Math.max(1, Math.floor(available / count));
    // 反向算出精准对齐后的最终实际画布尺寸
    const finalSize = cell * count + margin * 2;

    // 重设画布物理宽高（会清空画布）
    canvas.width = finalSize;
    canvas.height = finalSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;

    // 1. 铺上纯白色底色
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, finalSize, finalSize);

    // 2. 绘制深色方块（采用柔和护眼的高对比深碳色 #1c1917 代替死黑）
    ctx.fillStyle = '#1c1917';
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        // 如果该网格是黑色模块，填充小矩形
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

/**
 * 从任意图像源识别并解析二维码中的文本内容
 *
 * 【多源通用性】：
 * - 传 `<video>`：摄像头实时动态取景帧识别；
 * - 传 `<img>`：相册上传的静态照片识别；
 * - 传 `<canvas>`：截屏或离屏画布识别。
 *
 * 【双层识别流水线（Dual-Engine Pipeline）】：
 * 1. 第一层（硬件加速）：现代浏览器原生内置的 BarcodeDetector API（GPU 硬件加速，毫秒级，0 CPU 占用）；
 * 2. 第二层（通用兜底）：纯 JavaScript 实现的 jsQR 算法库（兼容不支持原生 API 的旧版 iOS/Safari/Firefox）。
 *
 * @param source 图像来源节点（Video/Image/Canvas）
 * @returns 解析出的字符串内容；未识别到二维码时返回 null
 */
export async function detectQrFromSource(
  source: HTMLCanvasElement | HTMLVideoElement | HTMLImageElement
): Promise<string | null> {
  if (!source) return null;

  // ==============================================================
  // 第 1 层：优先尝试原生硬件加速 BarcodeDetector (Chrome 83+, Android)
  // ==============================================================
  const BarcodeDetectorClass = (window as unknown as { BarcodeDetector?: any }).BarcodeDetector;
  if (typeof BarcodeDetectorClass !== 'undefined') {
    try {
      const detector = new BarcodeDetectorClass({ formats: ['qr_code'] });
      const barcodes = await detector.detect(source);
      if (barcodes && barcodes.length > 0 && barcodes[0].rawValue) {
        return barcodes[0].rawValue;
      }
    } catch {
      // 若硬件加速探测异常，自动平稳滑向第 2 层 jsQR
    }
  }

  // ==============================================================
  // 第 2 层：使用纯 JS 实现的 jsQR 算法库进行图像分析
  // ==============================================================
  try {
    // 1. 获取源图像的真实原始尺寸
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

    // 2. 图像超限等比缩放（防大图卡顿）：
    // 现代手机拍出的照片动辄 4000x3000 (1200万~4800万像素)，直接分析几千万像素会导致手机页面瞬间卡死！
    // 将最大边长等比限制在 1200px 内，既能保留足够的二维码细节，又大幅提升识别速度。
    const maxDimension = 1200;
    let scale = 1;
    if (width > maxDimension || height > maxDimension) {
      scale = maxDimension / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }

    // 3. 创建离屏画布（Offscreen Canvas）提取像素
    const offscreen = document.createElement('canvas');
    offscreen.width = width;
    offscreen.height = height;
    // willReadFrequently: true 告诉浏览器声卡/显卡优化频繁的 getImageData 读取
    const ctx = offscreen.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    // 把原始图像压缩绘制到离屏画布上
    ctx.drawImage(source, 0, 0, width, height);
    // 提取 RGBA 像素一维数组 (Uint8ClampedArray)
    const imageData = ctx.getImageData(0, 0, width, height);

    // 4. 调用 jsQR 进行点阵寻址和 Reed-Solomon 纠错解码
    const result = jsQR(imageData.data, width, height, {
      // attemptBoth: 同时尝试正向（白底黑码）与反向反色（黑底白码，如暗黑模式截图），识别成功率翻倍
      inversionAttempts: 'attemptBoth',
    });

    return result ? result.data : null;
  } catch (err) {
    console.error('jsQR 识别异常:', err);
    return null;
  }
}

