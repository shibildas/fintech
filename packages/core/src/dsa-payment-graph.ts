/**
 * Day 3 Fintech DSA — Payment Network Graph (BFS Reachability + Dijkstra Min-Cost/Latency Routing)
 *
 * Used in payment switches, correspondent banking (ISO 20022), and multi-hop settlement networks
 * to find the lowest-latency or lowest-fee path between two participants while dynamically
 * excluding `DOWN` participants or overloaded links.
 *
 * Time Complexity:
 * - hasHealthyRouteBfs(source, target): O(V + E)
 * - findOptimalRouteDijkstra(source, target): O((V + E) log V)
 */

export interface CorridorEdge {
  from: string;
  to: string;
  latencyMs: number;
  feeBps: number;
  active: boolean;
}

export interface RouteResult {
  path: string[];
  totalCost: number;
  totalLatencyMs: number;
  totalFeeBps: number;
}

export class PaymentCorridorGraph {
  private readonly adjacency = new Map<string, CorridorEdge[]>();
  private readonly downNodes = new Set<string>();

  public addNode(nodeId: string): void {
    if (!this.adjacency.has(nodeId)) {
      this.adjacency.set(nodeId, []);
    }
  }

  public setNodeDown(nodeId: string, isDown: boolean): void {
    if (isDown) {
      this.downNodes.add(nodeId);
    } else {
      this.downNodes.delete(nodeId);
    }
  }

  public addCorridor(edge: CorridorEdge): void {
    this.addNode(edge.from);
    this.addNode(edge.to);
    this.adjacency.get(edge.from)!.push(edge);
  }

  /**
   * BFS (Breadth-First Search) to find the minimum-hop healthy route (`O(V + E)`).
   */
  public findMinHopRouteBfs(source: string, target: string): string[] | null {
    if (this.downNodes.has(source) || this.downNodes.has(target)) {
      return null;
    }
    if (source === target) {
      return [source];
    }

    const visited = new Set<string>([source]);
    const parent = new Map<string, string>();
    const queue: string[] = [source];

    let head = 0;
    while (head < queue.length) {
      const curr = queue[head++];
      const edges = this.adjacency.get(curr) ?? [];

      for (const edge of edges) {
        if (!edge.active || this.downNodes.has(edge.to) || visited.has(edge.to)) {
          continue;
        }
        visited.add(edge.to);
        parent.set(edge.to, curr);
        if (edge.to === target) {
          return this.reconstructPath(parent, source, target);
        }
        queue.push(edge.to);
      }
    }

    return null;
  }

  /**
   * Dijkstra's Algorithm to find the lowest-cost route (`cost = latencyWeight * latencyMs + feeWeight * feeBps`)
   * across healthy nodes and active corridors.
   */
  public findOptimalRouteDijkstra(
    source: string,
    target: string,
    options?: { latencyWeight?: number; feeWeight?: number }
  ): RouteResult | null {
    if (this.downNodes.has(source) || this.downNodes.has(target)) {
      return null;
    }
    const latencyWeight = options?.latencyWeight ?? 1;
    const feeWeight = options?.feeWeight ?? 10;

    const dist = new Map<string, number>();
    const latencyMap = new Map<string, number>();
    const feeMap = new Map<string, number>();
    const parent = new Map<string, string>();
    const visited = new Set<string>();

    dist.set(source, 0);
    latencyMap.set(source, 0);
    feeMap.set(source, 0);

    // Priority queue entries: [cost, nodeId]
    const pq: Array<[number, string]> = [[0, source]];

    while (pq.length > 0) {
      // Pop minimum cost node
      pq.sort((a, b) => a[0] - b[0]);
      const [currCost, u] = pq.shift()!;

      if (visited.has(u)) {
        continue;
      }
      visited.add(u);

      if (u === target) {
        return {
          path: this.reconstructPath(parent, source, target),
          totalCost: currCost,
          totalLatencyMs: latencyMap.get(target)!,
          totalFeeBps: feeMap.get(target)!,
        };
      }

      const edges = this.adjacency.get(u) ?? [];
      for (const edge of edges) {
        if (!edge.active || this.downNodes.has(edge.to) || visited.has(edge.to)) {
          continue;
        }
        const edgeCost =
          latencyWeight * edge.latencyMs + feeWeight * edge.feeBps;
        const nextCost = currCost + edgeCost;

        if (nextCost < (dist.get(edge.to) ?? Number.POSITIVE_INFINITY)) {
          dist.set(edge.to, nextCost);
          latencyMap.set(edge.to, latencyMap.get(u)! + edge.latencyMs);
          feeMap.set(edge.to, feeMap.get(u)! + edge.feeBps);
          parent.set(edge.to, u);
          pq.push([nextCost, edge.to]);
        }
      }
    }

    return null;
  }

  private reconstructPath(
    parent: Map<string, string>,
    source: string,
    target: string
  ): string[] {
    const path: string[] = [];
    let curr: string | undefined = target;
    while (curr !== undefined) {
      path.push(curr);
      if (curr === source) {
        break;
      }
      curr = parent.get(curr);
    }
    return path.reverse();
  }
}
