/** Network generation worker: keeps tens of thousands of kNN queries off the UI thread. */
import { generateNetwork, type NetGenInput } from '../graphics/netgen';

const ctx = self as unknown as { onmessage: ((e: MessageEvent<NetGenInput>) => void) | null; postMessage(msg: unknown, transfer: Transferable[]): void };
ctx.onmessage = (e) => {
  const net = generateNetwork(e.data);
  ctx.postMessage(net, [net.positions.buffer, net.edges.buffer, net.lengths.buffer, net.order.buffer, net.degree.buffer, net.cluster.buffer, net.hubs.buffer, net.nodeOrder.buffer]);
};
