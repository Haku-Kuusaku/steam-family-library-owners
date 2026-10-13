// 把 src/ui/core.js 同步成 millennium/frontend/core.ts。
//
// 为什么要同步而不是直接 import：core.js 是「一段没有模块语法的普通 JS」——
// 免安装原型靠字符串拼接 + CDP 注入运行，加了 export 就会语法报错；
// 而 Millennium 走的是正常打包，需要模块导出。两边要求冲突，所以用这个脚本生成。
//
//   node millennium/scripts/sync-core.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(here, '..', '..', 'src', 'ui', 'core.js');
const TARGET = join(here, '..', 'frontend', 'core.ts');

const banner = `// ⚠️ 自动生成，请勿直接编辑。
// 来源：src/ui/core.js
// 重新生成：node millennium/scripts/sync-core.mjs
//
// @ts-nocheck —— 这段代码是从已在免安装原型上验证过的 JS 原样搬来的，
// 不做类型标注（host 参数是运行时注入的宿主对象）。
`;

const exportLine = '\nexport { createFamilyLensUi };\n';

const body = readFileSync(SOURCE, 'utf8');
if (!body.includes('function createFamilyLensUi')) {
  console.error('src/ui/core.js 里找不到 createFamilyLensUi，未同步');
  process.exit(1);
}
writeFileSync(TARGET, banner + body + exportLine, 'utf8');
console.log(`已同步 → ${TARGET}（${body.length} 字符）`);
