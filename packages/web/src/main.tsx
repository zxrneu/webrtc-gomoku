/**
 * 前端应用程序挂载入口 (Application Mount Entry)
 *
 * 采用 React 19 的标准 createRoot API 进行 DOM 挂载。
 * React.StrictMode 在本地开发环境下会进行两次渲染探测，以帮助开发者提前发现未清理的副作用与内存泄漏。
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { LobbyProvider } from './lobby/LobbyProvider';
import { App } from './App';
import './styles/global.css';

// 获取 index.html 中的 #root 容器并渲染主应用组件
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {__LOBBY_ENABLED__ ? <LobbyProvider><App /></LobbyProvider> : <App />}
  </React.StrictMode>
);

