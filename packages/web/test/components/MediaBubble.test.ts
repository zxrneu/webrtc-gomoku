import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { MediaBubble } from '../../src/components/Chat/MediaBubble';

describe('MediaBubble 安全渲染', () => {
  it('普通位图图片（如 PNG）在新标签页打开预览', () => {
    const html = renderToStaticMarkup(
      React.createElement(MediaBubble, {
        item: {
          id: '1',
          sender: 'peer',
          time: '12:00',
          mediaId: 'm1',
          kind: 'image',
          url: 'blob:http://localhost:3000/test-png',
          name: 'photo.png',
          size: 1024,
        },
      }),
    );
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).toContain('<img');
    expect(html).toContain('alt="photo.png"');
    expect(html).not.toContain('download=');
  });

  it('SVG 图片必须降级为下载文件，严禁在新标签页打开（防同源脚本执行 XSS）', () => {
    const html = renderToStaticMarkup(
      React.createElement(MediaBubble, {
        item: {
          id: '2',
          sender: 'peer',
          time: '12:00',
          mediaId: 'm2',
          kind: 'image',
          url: 'blob:http://localhost:3000/xss-payload',
          name: 'malicious.svg',
          size: 512,
        },
      }),
    );
    // 严禁在新标签打开直接执行 XML/SVG 内嵌脚本
    expect(html).not.toContain('target="_blank"');
    // 降级为安全下载模式
    expect(html).toContain('download="malicious.svg"');
    expect(html).toContain('下载');
  });

  it('常规文件消息保持 download 属性与下载卡片样式', () => {
    const html = renderToStaticMarkup(
      React.createElement(MediaBubble, {
        item: {
          id: '3',
          sender: 'peer',
          time: '12:00',
          mediaId: 'm3',
          kind: 'file',
          url: 'blob:http://localhost:3000/file-blob',
          name: 'data.csv',
          size: 2048,
        },
      }),
    );
    expect(html).not.toContain('target="_blank"');
    expect(html).toContain('download="data.csv"');
    expect(html).toContain('data.csv');
  });
});
