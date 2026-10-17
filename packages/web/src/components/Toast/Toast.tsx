import React from 'react';
import styles from './Toast.module.css';

/**
 * 轻提示组件入参属性接口
 */
interface ToastProps {
  /** 提示消息内容，若为 null 则自动隐藏 */
  message: string | null;
}

/**
 * 屏幕浮动轻提示组件 (Toast)
 * 职责：显示短暂的轻量级操作反馈（如 "连接码已复制到剪贴板"、"对方拒绝了悔棋申请" 等）
 * 采用自顶向下传入 message，在有内容时通过渐隐动画浮现在屏幕上方居中位置
 */
export const Toast: React.FC<ToastProps> = ({ message }) => {
  return (
    <div
      id="toast"
      className={`${styles.toast} toast ${message ? '' : 'hidden'}`}
      style={{ display: message ? 'block' : 'none' }}
    >
      {message}
    </div>
  );
};
