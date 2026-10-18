import { createSearchWorkerHandler } from './workerRuntime';

const receive = createSearchWorkerHandler((reply) => self.postMessage(reply));
self.addEventListener('message', (event: MessageEvent<unknown>) => receive(event.data));
