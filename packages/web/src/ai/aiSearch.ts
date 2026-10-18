/** 内嵌 Worker 随单文件页面离线分发，不额外请求脚本。 */
import AiWorker from './search.worker?worker&inline';
import { createWorkerSearchDriver, type SearchWorker } from './workerClient';

function createBrowserWorker(): SearchWorker | null {
  if (typeof Worker === 'undefined') return null;
  const worker = new AiWorker();
  return {
    send: (request) => worker.postMessage(request),
    listen: (receive, fail) => {
      const onMessage = (event: MessageEvent<unknown>): void => receive(event.data);
      const onError = (event: Event): void => { event.preventDefault(); fail(); };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.addEventListener('messageerror', onError);
      return () => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        worker.removeEventListener('messageerror', onError);
      };
    },
    terminate: () => worker.terminate(),
  };
}

export const runAiSearch = createWorkerSearchDriver(createBrowserWorker);
