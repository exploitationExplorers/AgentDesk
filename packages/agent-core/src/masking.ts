/**
 * 发给第三方模型之前的内容脱敏：命中规则替换成确定性占位符，拿到回复后换回真实值。
 * 只做规则/正则 + 校验和的确定性检测（不做本地 NER 模型），误伤即放行——单条规则出错
 * 不能整体失败，跳过该条继续处理其余内容。
 */

export interface MaskStore {
  valueToPlaceholder: Map<string, string>;
  placeholderToValue: Map<string, string>;
}

export function createMaskStore(): MaskStore {
  return { valueToPlaceholder: new Map(), placeholderToValue: new Map() };
}

function placeholderFor(kind: string, value: string, store: MaskStore): string {
  const existing = store.valueToPlaceholder.get(value);
  if (existing) return existing;
  const placeholder = `{{MASK_${kind}_${store.valueToPlaceholder.size + 1}}}`;
  store.valueToPlaceholder.set(value, placeholder);
  store.placeholderToValue.set(placeholder, value);
  return placeholder;
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const ID_CARD_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CARD_CHECK_CODES = "10X98765432";
function idCardValid(id: string): boolean {
  if (!/^\d{17}[\dXx]$/.test(id)) return false;
  const sum = ID_CARD_WEIGHTS.reduce((acc, w, i) => acc + w * Number(id[i]), 0);
  return ID_CARD_CHECK_CODES[sum % 11] === id.at(-1)!.toUpperCase();
}

interface Detector {
  kind: string;
  regex: RegExp;
  /** 命中后用哪个捕获组的值做脱敏（默认整段匹配）；返回 null 表示这次命中不通过校验，不脱敏。 */
  pick?: (match: RegExpMatchArray) => string | null;
}

const DETECTORS: Detector[] = [
  {
    kind: "PRIVATE_KEY",
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    kind: "API_KEY",
    regex:
      /\b(?:sk-ant-[a-zA-Z0-9_-]{10,}|sk-[a-zA-Z0-9]{10,}|ghp_[a-zA-Z0-9]{30,}|gho_[a-zA-Z0-9]{30,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{30,})\b/g,
  },
  {
    kind: "API_KEY",
    regex:
      /\b(?:api[_-]?key|secret|access[_-]?token|password)\s*[:=]\s*['"]?([A-Za-z0-9_\-./+]{8,})['"]?/gi,
    pick: (m) => m[1] ?? null,
  },
  { kind: "EMAIL", regex: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g },
  { kind: "PHONE", regex: /\b1[3-9]\d{9}\b/g },
  {
    kind: "ID_CARD",
    regex: /\b\d{17}[\dXx]\b/g,
    pick: (m) => (idCardValid(m[0]) ? m[0] : null),
  },
  {
    kind: "CARD",
    regex: /\b\d{13,19}\b/g,
    pick: (m) => (luhnValid(m[0]) ? m[0] : null),
  },
];

export function maskText(text: string, store: MaskStore): string {
  let result = text;
  for (const detector of DETECTORS) {
    try {
      result = result.replace(detector.regex, (...args) => {
        // String.replace 回调签名：(match, p1, p2, ..., offset, string)，去掉末尾这两个非捕获组参数
        // 剩下的刚好是一个可按下标访问的"伪 RegExpMatchArray"：groups[0]=整段匹配，groups[1..]=捕获组。
        const groups = args.slice(0, -2) as unknown as RegExpMatchArray;
        const full = groups[0];
        const value = detector.pick ? detector.pick(groups) : full;
        if (!value) return full;
        const placeholder = placeholderFor(detector.kind, value, store);
        return value === full ? placeholder : full.replace(value, placeholder);
      });
    } catch {
      // 单条规则出错不能影响其余内容，跳过继续。
    }
  }
  return result;
}

const PLACEHOLDER_RE = /\{\{MASK_[A-Z_]+_\d+\}\}/g;
const PLACEHOLDER_PREFIX_RE = /\{\{MASK_[A-Z_]*\d*$/;

export function unmaskText(text: string, store: MaskStore): string {
  if (store.placeholderToValue.size === 0) return text;
  return text.replace(PLACEHOLDER_RE, (match) => store.placeholderToValue.get(match) ?? match);
}

function walk(value: unknown, transform: (text: string) => string): unknown {
  if (typeof value === "string") return transform(value);
  if (Array.isArray(value)) return value.map((item) => walk(item, transform));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = walk(item, transform);
    return out;
  }
  return value;
}

/** 递归遍历任意 JSON 值（对话消息数组、工具参数/结果等），对每个字符串叶子做脱敏。 */
export function maskJson<T>(value: T, store: MaskStore): T {
  return walk(value, (text) => maskText(text, store)) as T;
}

/** 对称的反脱敏：同样递归遍历，把占位符换回真实值。 */
export function unmaskJson<T>(value: T, store: MaskStore): T {
  return walk(value, (text) => unmaskText(text, store)) as T;
}

/**
 * 流式文本的跨块缓冲反脱敏：占位符可能被模型的流式输出切断在两个 delta 之间，
 * 每次 push 只返回"确认安全可以直接展示"的前缀，不完整的占位符前缀留在缓冲区等下一块；
 * flush() 在流结束时强制吐出剩余缓冲（哪怕不是完整占位符，避免丢字）。
 */
export function createStreamUnmasker(store: MaskStore) {
  let buffer = "";
  return {
    push(delta: string): string {
      buffer += delta;
      const prefixMatch = PLACEHOLDER_PREFIX_RE.exec(buffer);
      const safeEnd = prefixMatch ? prefixMatch.index : buffer.length;
      const safe = buffer.slice(0, safeEnd);
      buffer = buffer.slice(safeEnd);
      return safe ? unmaskText(safe, store) : "";
    },
    flush(): string {
      const rest = buffer;
      buffer = "";
      return rest ? unmaskText(rest, store) : "";
    },
  };
}
