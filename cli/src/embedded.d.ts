/**
 * `import x from "./f.py" with { type: "file" }` 在 Bun 里返回的是一个路径字符串，
 * 编译成单文件后指向内嵌副本。TypeScript 不认这些扩展名，这里声明一下。
 * 只影响类型检查，运行时行为完全由 Bun 决定。
 */
declare module "*.py" { const path: string; export default path; }
declare module "*.md" { const path: string; export default path; }
declare module "*.txt" { const path: string; export default path; }
