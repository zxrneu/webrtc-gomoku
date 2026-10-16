import React from 'react';
import type { ModalState } from '../../types';
import styles from './ConfirmModal.module.css';

interface ConfirmModalProps {
  modal: ModalState;
}

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
          <button
            id="modal-ok"
            className={`${styles.btn} ${styles.btnPrimary} btn primary`}
            onClick={modal.onOk}
          >
            同意
          </button>
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
