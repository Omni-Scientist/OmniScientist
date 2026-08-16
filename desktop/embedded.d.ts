/**
 * 内嵌资源：`with { type: "file" }` 返回路径字符串，编译后指向二进制里的副本。
 * TypeScript 不认这些扩展名，这里声明。只影响类型检查。
 */
declare module "*.py" { const path: string; export default path; }
declare module "*.md" { const path: string; export default path; }
declare module "*.txt" { const path: string; export default path; }
declare module "*.png" { const path: string; export default path; }
declare module "*.jpg" { const path: string; export default path; }
declare module "*.svg" { const path: string; export default path; }
declare module "*.pdf" { const path: string; export default path; }
declare module "*.woff2" { const path: string; export default path; }
declare module "*.ttf" { const path: string; export default path; }
declare module "*.ico" { const path: string; export default path; }
declare module "*.html" { const path: string; export default path; }
declare module "*.css" { const path: string; export default path; }
declare module "*.js" { const path: string; export default path; }
