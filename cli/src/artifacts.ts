/**
 * 工具输出仓库。
 *
 * 之前工具输出超限就硬截断，截掉那部分永远没了，模型也不知道怎么再拿。
 * 现在截断时留一个句柄，完整内容存在这儿，模型可以用 read_more 按需续取。
 *
 * 关键设计：完整内容**不进上下文**，只有被显式取用的片段才进。
 * 这是压缩的另一种形式：不让一次 `cat` 大文件把窗口打满。
 */

export interface Artifact {
  handle: string;
  source: string; // 哪个工具产生的，给人看
  content: string;
  createdAt: number;
}

export class ArtifactStore {
  private items = new Map<string, Artifact>();
  private seq = 0;
  /** 每个句柄已经被续取走了多少字符。见 noteFetched。 */
  private fetched = new Map<string, number>();

  put(source: string, content: string): Artifact {
    const handle = `art_${++this.seq}`;
    const a: Artifact = { handle, source, content, createdAt: Date.now() };
    this.items.set(handle, a);
    return a;
  }

  get(handle: string): Artifact {
    const a = this.items.get(handle);
    if (!a) {
      // 不返回空串糊弄过去：句柄错了就是错了，让模型看见
      throw new Error(
        `没有句柄 ${handle}。现有的是: ${[...this.items.keys()].join(", ") || "（空）"}`,
      );
    }
    return a;
  }

  list(): Artifact[] {
    return [...this.items.values()];
  }

  /**
   * 记一笔续取，返回这个句柄到目前为止总共取走了多少字符。
   *
   * 单条工具结果的上限（toolResultBudget）拦得住「一次大输出打满窗口」，拦不住
   * 「分二十次把同一份大输出全搬进来」—— read_more 每次要 20000 字符，取五次就是
   * 十万字符。2026-08-26 实测：模型对着一个大文件连取五次，直接把 131072 的窗口
   * 撑破，触发了强制压缩救援。
   *
   * 所以累计量也要有账。这里只管记账和报数，卡不卡由调用方决定。
   */
  noteFetched(handle: string, chars: number): number {
    const total = (this.fetched.get(handle) ?? 0) + Math.max(0, chars);
    this.fetched.set(handle, total);
    return total;
  }

  /** 这个句柄已经取走了多少。 */
  fetchedSoFar(handle: string): number {
    return this.fetched.get(handle) ?? 0;
  }

  /**
   * 截断并登记。返回给模型看的那段文本，尾部带取回说明。
   * 没超限就原样返回，不留句柄，避免到处是没用的句柄。
   */
  truncate(source: string, content: string, limit: number): string {
    if (content.length <= limit) return content;
    const a = this.put(source, content);
    return (
      `${content.slice(0, limit)}\n\n` +
      `[输出被截断：共 ${content.length} 字符，上面是前 ${limit} 个。` +
      `完整内容存为 ${a.handle}，用 read_more 取，比如 ` +
      `read_more(handle="${a.handle}", offset=${limit})]`
    );
  }
}
