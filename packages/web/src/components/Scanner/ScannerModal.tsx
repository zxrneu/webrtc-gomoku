import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { ScannerTarget } from '../../types';
import { detectQrFromSource } from '../../qr';
import styles from './ScannerModal.module.css';

interface ScannerModalProps {
  target: ScannerTarget;
  onClose: () => void;
  onScan: (text: string) => void;
}

export const ScannerModal: React.FC<ScannerModalProps> = ({
  target,
  onClose,
  onScan,
}) => {
  const isOpen = target !== null;
  const [errorText, setErrorText] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  const stopCamera = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const scanLoop = useCallback(async () => {
    const video = videoRef.current;
    if (!video || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(scanLoop);
      return;
    }

    try {
      const code = await detectQrFromSource(video);
      if (code) {
        stopCamera();
        onScan(code);
        return;
      }
    } catch {}

    rafRef.current = requestAnimationFrame(scanLoop);
  }, [onScan, stopCamera]);

  const startCamera = useCallback(async () => {
    stopCamera();
    setErrorText(null);

    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      !navigator.mediaDevices.getUserMedia
    ) {
      setErrorText('未能打开摄像头（权限受限或当前环境不支持）');
      return;
    }

    try {
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
        rafRef.current = requestAnimationFrame(scanLoop);
      }
    } catch {
      setErrorText('未能打开摄像头（权限受限或当前环境不支持）');
    }
  }, [facingMode, scanLoop, stopCamera]);

  useEffect(() => {
    if (isOpen) {
      startCamera();
    } else {
      stopCamera();
    }
    return () => {
      stopCamera();
    };
  }, [isOpen, startCamera, stopCamera]);

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

        <div className={`${styles.scannerBody} scanner-body`}>
          {!errorText ? (
            <div id="scanner-view-wrap" className={`${styles.scannerViewWrap} scanner-view-wrap`}>
              <video
                id="scanner-video"
                ref={videoRef}
                className={`${styles.scannerVideo} scanner-video`}
                autoPlay
                playsInline
                muted
              />
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
