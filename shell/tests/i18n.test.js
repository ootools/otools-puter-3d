// @vitest-environment jsdom
/**
 * 多语言运行时的边界。
 *
 * 刻意**不**断言任何具体词条：词典内容每个插件都不一样，而且会持续补。
 * 这里只测「机制」——语言怎么定、缺词怎么退、参数怎么替换、切语言怎么通知。
 * 具体词条有没有翻对，交给 `node scripts/i18n-report.mjs`。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  SOURCE_LOCALE, catalogSize, has, installI18n, isRTL, locale, localeChoices,
  localeOptionPairs, normalizeLocale, onChange, patternSize, preference,
  registerCatalog, setPreference, t,
} from '../src/otools/i18n.js';

/** 每个用例都要一个干净的环境：语言、localStorage、宿主注入的全局都归零。 */
function reset() {
  window.localStorage.clear();
  delete window.__OTOOLS_LOCALE__;
  document.documentElement.removeAttribute('lang');
  // 模块级状态靠重新解析推回默认值
  setPreference('auto');
}

describe('语言归一', () => {
  beforeEach(reset);

  it('认得宿主推的 zh-CN', () => {
    expect(normalizeLocale('zh-CN')).toBe('zh-CN');
  });

  it('同一语言族的其它写法归一到 zh-CN', () => {
    expect(normalizeLocale('zh')).toBe('zh-CN');
    expect(normalizeLocale('zh-Hans-CN')).toBe('zh-CN');
  });

  it('英文就是原文', () => {
    expect(normalizeLocale('en-US')).toBe(SOURCE_LOCALE);
    expect(normalizeLocale('en')).toBe(SOURCE_LOCALE);
  });

  it('没有词典的语言归为空串（调用方退回英文）', () => {
    expect(normalizeLocale('ja-JP')).toBe('');
    expect(normalizeLocale('')).toBe('');
  });
});

describe('翻译', () => {
  beforeEach(reset);

  it('缺词时返回原文——露英文比露 key 好', () => {
    setPreference('zh-CN');
    expect(t('Totally Unknown Phrase')).toBe('Totally Unknown Phrase');
  });

  it('精确词条优先于模式', () => {
    registerCatalog('zz-ZZ', { 'Hello {name}': '你好 {name}' }, [[/^Hello (.+)$/, '模式命中 $1']]);
    setPreference('zz-ZZ');
    expect(t('Hello {name}', { name: 'Ada' })).toBe('你好 Ada');
  });

  it('模式命中带插值的文案', () => {
    registerCatalog('zz-ZZ', {}, [[/^Open (.+)$/, '打开 $1']]);
    setPreference('zz-ZZ');
    expect(t('Open report.docx')).toBe('打开 report.docx');
  });

  it('模式的替换函数返回空串视为不适用，保留原文', () => {
    registerCatalog('zz-ZZ', {}, [[/^Skip (.+)$/, () => '']]);
    setPreference('zz-ZZ');
    expect(t('Skip this')).toBe('Skip this');
  });

  it('参数替换只认存在的占位，其它原样留着', () => {
    registerCatalog('zz-ZZ', { '{a} and {b}': '{a} 和 {b}' }, []);
    setPreference('zz-ZZ');
    expect(t('{a} and {b}', { a: 'X' })).toBe('X 和 {b}');
  });

  it('has() 对精确与模式命中都成立', () => {
    registerCatalog('zz-ZZ', { Yes: '是' }, [[/^Open (.+)$/, '打开 $1']]);
    setPreference('zz-ZZ');
    expect(has('Yes')).toBe(true);
    expect(has('Open a')).toBe(true);
    expect(has('Nope')).toBe(false);
  });

  it('内置简体中文词典确实注册上了', () => {
    expect(catalogSize('zh-CN')).toBeGreaterThan(0);
  });

  it('模式表可以为空但不报错', () => {
    expect(patternSize('zh-CN')).toBeGreaterThanOrEqual(0);
  });
});

describe('语言来源的优先级', () => {
  beforeEach(reset);

  it('用户显式选的语言压过宿主', () => {
    window.__OTOOLS_LOCALE__ = { locale: 'en-US' };
    installI18n();
    setPreference('zh-CN');
    expect(locale()).toBe('zh-CN');
    expect(preference()).toBe('zh-CN');
  });

  it('默认 auto：宿主把语言推过来就跟着切', () => {
    // installI18n() 是幂等的（装过就不再重装），所以「宿主后来又推了一次」
    // 要用事件来模拟——这也是真实的运行路径。
    installI18n();
    window.dispatchEvent(new CustomEvent('otools-locale-changed', { detail: { locale: 'zh-CN' } }));
    expect(locale()).toBe('zh-CN');
  });

  it('宿主把 lang 属性改了（事件没到）也能跟上', async () => {
    installI18n();
    document.documentElement.setAttribute('lang', 'zh-CN');
    // MutationObserver 是微任务，等一拍
    await Promise.resolve();
    expect(locale()).toBe('zh-CN');
  });

  it('宿主没说话时退回浏览器语言，再不济退回英文', () => {
    installI18n();
    expect([SOURCE_LOCALE, 'zh-CN']).toContain(locale());
  });
});

describe('菜单项', () => {
  beforeEach(reset);

  it('第一项是「跟随 OTools」，且它的显示名跟着当前语言走', () => {
    const pairs = localeOptionPairs();
    expect(pairs[0][0]).toBe('auto');
    expect(pairs[0][1]).toBeTruthy();
    setPreference('zh-CN');
    expect(t('Follow OTools')).toBe(localeOptionPairs()[0][1]);
  });

  it('选项里一定有简体中文和英文', () => {
    const values = localeChoices().map(([v]) => v);
    expect(values).toContain('zh-CN');
    expect(values).toContain('en-US');
  });
});

describe('变更通知', () => {
  beforeEach(reset);

  it('切语言会通知订阅者', () => {
    // 先钉在一个已知语言上，否则上一个用例留下的状态会让这次「切换」变成空操作。
    setPreference('en-US');
    const seen = [];
    const off = onChange((next, previous) => seen.push([previous, next]));
    setPreference('zh-CN');
    off();
    expect(seen.length).toBe(1);
    expect(seen[0][1]).toBe('zh-CN');
  });

  it('退订之后不再收到通知', () => {
    const seen = [];
    const off = onChange(() => seen.push(1));
    off();
    setPreference('zh-CN');
    expect(seen.length).toBe(0);
  });
});

describe('书写方向', () => {
  it('已知语言里只有阿拉伯语是从右往左', () => {
    expect(isRTL('ar-SA')).toBe(true);
    expect(isRTL('zh-CN')).toBe(false);
    expect(isRTL('en-US')).toBe(false);
  });
});

/**
 * 词典文件本身的「可加载性」。
 *
 * 这组用例守的是 `scripts/i18n-shards.mjs` 写出词典时踩过的两个坑——
 * 两次都表现为「`node --check` 语法校验通过，运行时整个插件白屏」：
 *
 *   1. **值被写成裸标识符**。键可以省略引号，值不行：`UVs: UV` 里的 `UV`
 *      被JS 当成变量引用，import 时抛 `UV is not defined`。
 *   2. **控制字符没转义**。Blender 的 tooltip 原文是 `标题\n说明`（`data-tip`
 *      属性里就带换行），字面换行落进单引号字符串是语法错误。
 *
 * 所以这里直接 import 真实词典，并断言「键值都是字符串、含换行的键能取到」。
 */
describe('词典文件可加载', () => {
  it('每个词条的键和值都是字符串（没有裸标识符）', async () => {
    const dict = (await import('../src/otools/i18n.zh-CN.js')).default;
    for (const [k, v] of Object.entries(dict)) {
      expect(typeof k, `键 ${JSON.stringify(k)}`).toBe('string');
      expect(typeof v, `${JSON.stringify(k)} 的值`).toBe('string');
    }
  });

  it('tooltip 词条保留结构换行（标题\n说明）', async () => {
    const dict = (await import('../src/otools/i18n.zh-CN.js')).default;
    const NL = String.fromCharCode(10);
    const tips = Object.keys(dict).filter((k) => k.includes(NL));
    expect(tips.length).toBeGreaterThan(0);
    for (const k of tips) {
      // 上游 showTip() 按真换行 split 出标题与正文；译文也必须是两段，
      // 否则整段说明会被塞进 tooltip 标题里。
      const parts = dict[k].split(NL);
      expect(parts.length, JSON.stringify(k)).toBe(2);
      expect(parts[0].trim().length, JSON.stringify(k)).toBeGreaterThan(0);
      expect(parts[1].trim().length, JSON.stringify(k)).toBeGreaterThan(0);
    }
  });

  it('tooltip 词条没有把换行抹成空格的残留键', async () => {
    const dict = (await import('../src/otools/i18n.zh-CN.js')).default;
    const NL = String.fromCharCode(10);
    for (const k of Object.keys(dict)) {
      if (!k.includes(NL)) continue;
      const spaced = k.split(NL).join(' ');
      expect(dict, `残留空格版键：${spaced}`).not.toHaveProperty(spaced);
    }
  });

  it('值里的单引号与反斜杠被正确转义', async () => {
    const dict = (await import('../src/otools/i18n.zh-CN.js')).default;
    // 译文里出现 `'` 或 `\` 时若没转义，文件本身就是语法错误，
    // 能 import 成功即证明转义没问题；这里再钉住「原文里的撇号没被吃掉」。
    const curly = Object.entries(dict).filter(([k]) => k.includes('’'));
    expect(curly.length).toBeGreaterThan(0);
  });
});
