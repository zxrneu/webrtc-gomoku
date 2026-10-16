import React from 'react';
import styles from './Toast.module.css';

interface ToastProps {
  message: string | null;
}

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
