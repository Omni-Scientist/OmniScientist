/**
 * 从 shell 配置文本里解析出环境变量赋值。**纯函数，没有任何模块级副作用。**
 *
 * 单独一个文件是有原因的，别图省事挪回 credentials.ts：那个模块在模块体里就把
 * key 从 process.env 读走并删掉，谁 import 它谁就触发这件事。桌面版必须先
 * loadEnvFile 再 import 它，早一步就读到一片空（desktop/launcher/main.ts 里
 * 那几行动态 import 就是为这个）。而这个解析函数恰恰要在那之前用。
 */

/**
 * 从一段 shell 配置文本里**捡**出指定名字的赋值。绝不执行、绝不 source。
 *
 * 为什么需要这个：桌面版是双击起来的 GUI 进程，**拿不到 shell 的环境变量**。
 * macOS 上 Finder 启动的程序不走 .zshrc；Windows 上资源管理器启动的程序只继承
 * 注册表里那份用户环境变量，git-bash 里 `export` 的它一概不知道。于是用户在
 * `~/.keys.env` 里配好了 OPENAI_API_KEY，应用照样说"还没配 key"。
 *
 * 三条硬规矩，都不能松：
 *
 * 1. **只返回 allowed 里的名字。** 把用户 rc 里所有 export 都吸进来会踩到 PATH、
 *    LANG、http_proxy 这些，后果不可预期，而且是在别人的机器上不可预期。
 *    注意「只返回」不等于「只解析」，见下面第 3 条。
 *
 * 2. **绝不执行。** `$(...)` 和反引号是命令替换，一律丢弃，不做任何求值。
 *
 * 3. **`$NAME` 只在本文件里查。** `export DEEPSEEK_API_KEY="$DEEPSEEK_KEY"` 这种
 *    给同一把 key 起别名的写法很常见，实测撞到过：带 `$` 的值一开始被全丢了，
 *    结果就是「明明配了却认不到」。展开它不需要
 *    执行任何东西，纯文本替换而已，所以做：先按行顺序把**所有**赋值解析进一张
 *    表（这就是第 1 条说的「解析不等于返回」），`$NAME` 从这张表里取，
 *    取的必须是**前面已经出现过的**，跟 shell 的顺序语义一致。
 *    查不到就丢弃这条，绝不退回字面的 "$NAME"：那比读不到更糟，
 *    它看起来像配好了，一路带到 API 请求上才报鉴权失败。
 *    也绝不回退到 process.env：那等于把我们刚决定不信任的环境又引回来。
 *
 * 对读不懂的行一律跳过，不像 loadEnvFile 那样整份拒绝：那个文件是我们自己写的，
 * 一行不对就该整个不认；这个文件是用户的，里面有 if、函数、alias 是常态，
 * 为一行 alias 丢掉整份 key，用户只会看到"我明明配了"。
 */
export function harvestEnvAssignments(
  text: string,
  allowed: readonly string[],
): Record<string, string> {
  const want = new Set(allowed);
  /** 本文件里目前为止见过的所有赋值，给 $NAME 查。不含 process.env。 */
  const scope = new Map<string, string>();
  const out: Record<string, string> = {};

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1]!;

    let value = m[2]!.trim();
    const singleQuoted = value.length >= 2 && value.startsWith("'") && value.endsWith("'");
    const doubleQuoted = value.length >= 2 && value.startsWith('"') && value.endsWith('"');
    if (singleQuoted || doubleQuoted) value = value.slice(1, -1);
    // 没加引号时，shell 会把空格后的 # 当行尾注释，我们照做。
    else value = value.split(" #")[0]!.trim();

    // 命令替换一律不碰，连试都不试。
    if (/\$\(|`/.test(value)) continue;

    // 单引号里 shell 不做任何展开，我们也不做。
    if (!singleQuoted && value.includes("$")) {
      let unresolved = false;
      value = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_all, braced, bare) => {
        const ref = scope.get(braced ?? bare);
        if (ref === undefined) { unresolved = true; return ""; }
        return ref;
      });
      if (unresolved) continue;
    }

    // 走到这里还带 $ 的只有两种：单引号里的字面 $NAME，或者展开完没消掉的残渣。
    // 两种都丢。一个字面的 "$DEEPSEEK_KEY" 不可能是有效的 key，塞进去只会让
    // 界面显示"已配置"，等真发请求才报鉴权失败，比一开始就说没配更难查。
    if (value.includes("$")) continue;
    if (!value) continue;
    // 先到先得，跟 out 分开记：不在白名单的也要进 scope，它可能是别人的别名源。
    if (!scope.has(name)) scope.set(name, value);
    if (want.has(name) && out[name] === undefined) out[name] = value;
  }
  return out;
}
