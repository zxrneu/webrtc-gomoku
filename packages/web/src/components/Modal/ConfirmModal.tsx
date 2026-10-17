import React from 'react';
import type { ModalState } from '../../types';
import styles from './ConfirmModal.module.css';

/**
 * 确认对话框入参属性接口
 */
interface ConfirmModalProps {
  /** 模态框整体状态对象，包含打开标记、标题、正文及双按钮动作回调 */
  modal: ModalState;
}

/**
 * 通用确认模态弹窗组件 (ConfirmModal)
 * 职责：用于涉及双方权益的双向交互确认（如：对方请求悔棋、对方提议重新开始等）
 * 遵循无状态受控组件规范：弹窗的可见性及点击响应完全由外部 ModalState 驱动
 */
export const ConfirmModal: React.FC<ConfirmModalProps> = ({ modal }) => {
  return (
    <div
      id="modal-mask"
      className={`${styles.modalMask} modal-mask ${modal.open ? '' : 'hidden'}`}
      style={{ display: modal.open ? 'flex' : 'none' }}
    >
      <div className={`${styles.modal} modal`}>
        <h3 id="modal-title">{modal.title}</h3>
        <p id="modal-text">{modal.text}</p>
        <div className={`${styles.modalActions} modal-actions`}>
          {/* 同意/确认操作按钮 */}
          <button
            id="modal-ok"
            className={`${styles.btn} ${styles.btnPrimary} btn primary`}
            onClick={modal.onOk}
          >
            同意
          </button>
          {/* 拒绝/取消操作按钮 */}
          <button
            id="modal-no"
            className={`${styles.btn} btn`}
            onClick={modal.onNo}
          >
            拒绝
          </button>
        </div>
      </div>
    </div>
  );
};
