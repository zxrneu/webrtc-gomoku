import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { ScannerTarget } from '../../types';
import { detectQrFromSource } from '../../qr';
import styles from './ScannerModal.module.css';

/**
 * 扫码模态弹窗入参属性接口
 */
interface ScannerModalProps {
  /** 扫码目标分类：'guest-offer' (客端扫主端邀请码) | 'host-answer' (主端扫客端应答码) | null (关闭状态) */
  target: ScannerTarget;
  /** 关闭弹窗回调 */
  onClose: () => void;
  /** 识别出二维码连接码字符串后的成功回调 */
  onScan: (text: string) => void;
}

/**
 * 摄像头与相册二维码扫描组件 (ScannerModal)
 * 职责：
 * 1. 调用浏览器原生 `navigator.mediaDevices.getUserMedia` 获取实时视频流
 * 2. 在 requestAnimationFrame 循环中利用双引擎（BarcodeDetector / jsQR）逐帧抓取解码
 * 3. 硬件生命周期管理：弹窗关闭或组件卸载时彻底关闭相机 Track，释放摄像头硬件占用
 * 4. 降级容错：在未授权摄像头、HTTP 环境或无摄像头设备时，自动切换为相册图片解析
 */
export const ScannerModal: React.FC<ScannerModalProps> = ({
  target,
  onClose,
  onScan,
}) => {
  /** 弹窗是否处于可见打开状态 */
  const isOpen = target !== null;
  /** 摄像头异常或权限报错文本（非空时展示降级备选视图） */
  const [errorText, setErrorText] = useState<string | null>(null);
  /** 摄像头朝向模式：'environment' (后置广角扫码) | 'user' (前置自拍) */
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');

  /** 视频元素 DOM 引用，用于接收 MediaStream 视频流 */
  const videoRef = useRef<HTMLVideoElement | null>(null);
  /** 隐藏的原生相册文件选择框 `<input type="file">` 引用 */
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** 当前正在运行的 WebRTC 媒体流对象，用于 stopTrack 释放资源 */
  const streamRef = useRef<MediaStream | null>(null);
  /** requestAnimationFrame 动画帧标识句柄，用于取消高频扫码轮询 */
  const rafRef = useRef<number | null>(null);

  /**
   * 彻底释放摄像头资源与关闭帧循环
   */
  const stopCamera = useCallback(() => {
    // 1. 停止帧轮询，避免在组件关闭后持续耗电
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    // 2. 停止所有硬件媒体轨道（关掉手机/电脑上方的绿色摄像头指示灯）
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    // 3. 断开 video 元素的数据源关联
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  /**
   * 逐帧扫码高频轮询回路 (Scan Loop)
   */
  const scanLoop = useCallback(async () => {
    const video = videoRef.current;
    // video.readyState < 2 (HAVE_CURRENT_DATA) 说明首帧画面尚未解码就绪，跳过等待下一帧
    if (!video || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(scanLoop);
      return;
    }

    try {
      // 调用 qr.ts 中的混合双引擎识别器检测当前视频帧
      const code = await detectQrFromSource(video);
      if (code) {
        // 命中二维码！先优雅停机释放相机，再把结果向上派发
        stopCamera();
        onScan(code);
        return;
      }
    } catch {
      // 帧画面可能因运动模糊或光照不足识别失败，静默吞掉并继续下一帧
    }

    // 调度下一帧动画
    rafRef.current = requestAnimationFrame(scanLoop);
  }, [onScan, stopCamera]);

  /**
   * 申请并启动硬件摄像头媒体流
   */
  const startCamera = useCallback(async () => {
    stopCamera();
    setErrorText(null);

    // 环境能力探测：HTTP 非安全域或旧版浏览器不支持 getUserMedia
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      !navigator.mediaDevices.getUserMedia
    ) {
      setErrorText('未能打开摄像头（权限受限或当前环境不支持）');
      return;
    }

    try {
      // 优先请求后置摄像头，并请求 1280x720 分辨率以保证微小二维码清晰度
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facingMode },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        // 视频开始播放后，挂载高频帧扫描
        rafRef.current = requestAnimationFrame(scanLoop);
      }
    } catch {
      setErrorText('未能打开摄像头（权限受限或当前环境不支持）');
    }
  }, [facingMode, scanLoop, stopCamera]);

  // 当弹窗打开状态变动时启动或关闭相机
  useEffect(() => {
    if (isOpen) {
      startCamera();
    } else {
      stopCamera();
    }
    // 组件卸载时兜底清理
    return () => {
      stopCamera();
    };
  }, [isOpen, startCamera, stopCamera]);

  /**
   * 降级处理：相册图片选择并解析
   */
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const img = new Image();
        img.onload = async () => {
          const code = await detectQrFromSource(img);
          if (code) {
            stopCamera();
            onScan(code);
          } else {
            alert('未能从该图片中识别出有效二维码，请换一张试试');
          }
        };
        img.src = reader.result as string;
      };
      reader.readAsDataURL(file);
    } catch (err) {
      alert('解析图片失败：' + (err as Error).message);
    }
  };

  // 根据当前动作场景动态计算弹窗标题
  const title =
    target === 'guest-offer'
      ? '扫描邀请码'
      : target === 'host-answer'
      ? '扫描应答码'
      : '扫描对局二维码';

  return (
    <div
      id="scanner-mask"
      className={`${styles.modalMask} modal-mask ${isOpen ? '' : 'hidden'}`}
      style={{ display: isOpen ? 'flex' : 'none' }}
    >
      <div className={`${styles.scannerModal} modal scanner-modal`}>
        {/* 顶部标题栏与关闭叉号 */}
        <div className={`${styles.scannerHead} scanner-head`}>
          <h3 id="scanner-title">{title}</h3>
          <button
            id="scanner-close-btn"
            className={`${styles.btnClose} btn-close`}
            aria-label="关闭"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {/* 扫描取景区 */}
        <div className={`${styles.scannerBody} scanner-body`}>
          {!errorText ? (
            /* 摄像头正常取景区（带四角瞄准框与动态激光扫描线动画） */
            <div id="scanner-view-wrap" className={`${styles.scannerViewWrap} scanner-view-wrap`}>
              <video
                id="scanner-video"
                ref={videoRef}
                className={`${styles.scannerVideo} scanner-video`}
                autoPlay
                playsInline
                muted
              />
              {/* 拟物化扫描准心瞄准框与上下往复运动的绿色激光 */}
              <div className={`${styles.scannerReticle} scanner-reticle`}>
                <span className={`${styles.corner} ${styles.cornerTl} corner tl`} />
                <span className={`${styles.corner} ${styles.cornerTr} corner tr`} />
                <span className={`${styles.corner} ${styles.cornerBl} corner bl`} />
                <span className={`${styles.corner} ${styles.cornerBr} corner br`} />
                <div className={`${styles.scannerLaser} scanner-laser`} />
              </div>
              <div id="scanner-hint" className={`${styles.scannerHint} scanner-hint`}>
                将对方屏幕上的二维码置于框内
              </div>
            </div>
          ) : (
            /* 摄像头失败降级区（引导从系统相册选取二维码截图识别） */
            <div id="scanner-fallback" className={`${styles.scannerFallback} scanner-fallback`}>
              <div className={`${styles.fallbackIcon} fallback-icon`}>📷</div>
              <p id="scanner-error-text" className={`${styles.scannerErrorText}`}>
                {errorText}
              </p>
              <p className={`${styles.fallbackSub} fallback-sub`}>
                你可以选择保存好的二维码截图或照片直接识别：
              </p>
              <button
                id="scanner-select-file-btn"
                className={`${styles.btn} ${styles.btnPrimary} btn primary`}
                onClick={() => fileInputRef.current?.click()}
              >
                选择二维码图片识别
              </button>
            </div>
          )}

          {/* 隐藏的相册文件输入项 */}
          <canvas id="scanner-canvas" className="hidden" />
          <input
            id="scanner-file-input"
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>

        {/* 底部控制栏（切换前后置摄像头、相册选图、取消） */}
        <div className={`${styles.scannerFoot} scanner-foot`}>
          <button
            id="scanner-switch-cam-btn"
            className={`${styles.btn} ${styles.btnGhost} btn small ghost`}
            style={{ display: errorText ? 'none' : 'inline-flex' }}
            onClick={() => setFacingMode((prev) => (prev === 'environment' ? 'user' : 'environment'))}
          >
            切换镜头
          </button>
          <button
            id="scanner-album-btn"
            className={`${styles.btn} ${styles.btnGhost} btn small ghost`}
            onClick={() => fileInputRef.current?.click()}
          >
            相册选图
          </button>
          <button
            id="scanner-cancel-btn"
            className={`${styles.btn} btn small`}
            onClick={onClose}
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
};
