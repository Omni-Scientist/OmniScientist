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
