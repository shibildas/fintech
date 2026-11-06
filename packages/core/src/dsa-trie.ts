/**
 * Day 2 Fintech DSA — Longest-Prefix-Match (LPM) Routing Trie (`RoutingPrefixTrie`)
 *
 * Used across Payment Switches & Gateways for:
 * 1. Card BIN range routing (Project 2 Req 10: matching 6-to-8 digit issuer BINs like "411122" -> VISA/HDFC)
 * 2. IFSC branch prefix routing (Project 1 & 3: matching "BNKA0001" -> "BANKA")
 * 3. VPA namespace / suffix resolution
 *
 * Time Complexity:
 * - insert(prefix, metadata): O(L) where L is prefix length (e.g., L <= 11 for IFSC, L <= 8 for BIN)
 * - longestPrefixMatch(input): O(L) — independent of total number of rules N (whether 10 or 1,000,000!)
 */

class TrieNode<T> {
  public readonly children = new Map<string, TrieNode<T>>();
  public value: T | undefined = undefined;
  public matchedPrefix: string | undefined = undefined;
}

export interface PrefixMatchResult<T> {
  prefix: string;
  value: T;
}

export class RoutingPrefixTrie<T> {
  private readonly root = new TrieNode<T>();
  private ruleCount = 0;

  public get size(): number {
    return this.ruleCount;
  }

  /**
   * Inserts a routing prefix (case-insensitive normalized) with associated route target `value`.
   */
  public insert(prefix: string, value: T): void {
    const clean = prefix.trim().toUpperCase();
    if (!clean) {
      throw new Error("Prefix cannot be empty");
    }
    let curr = this.root;
    for (const ch of clean) {
      let next = curr.children.get(ch);
      if (!next) {
        next = new TrieNode<T>();
        curr.children.set(ch, next);
      }
      curr = next;
    }
    if (curr.value === undefined) {
      this.ruleCount += 1;
    }
    curr.value = value;
    curr.matchedPrefix = clean;
  }

  /**
   * Finds the most specific (longest) prefix rule matching `input` in O(L) time.
   * Example: If rules exist for "4" (VISA generic), "4111" (VISA India), and "411122" (HDFC Credit),
   * passing card "4111229988776655" returns the "411122" rule!
   */
  public longestPrefixMatch(input: string): PrefixMatchResult<T> | null {
    const clean = input.trim().toUpperCase();
    let curr: TrieNode<T> | undefined = this.root;
    let bestMatch: PrefixMatchResult<T> | null = null;

    for (const ch of clean) {
      curr = curr.children.get(ch);
      if (!curr) {
        break;
      }
      if (curr.value !== undefined && curr.matchedPrefix !== undefined) {
        bestMatch = {
          prefix: curr.matchedPrefix,
          value: curr.value,
        };
      }
    }

    return bestMatch;
  }
}
