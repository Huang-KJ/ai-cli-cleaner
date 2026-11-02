export function displayText(value: string): string {
  return value.replace(/[\\\x00-\x1f\x7f-\x9f\u2028\u2029\p{Bidi_Control}]/gu, (character) => {
    if (character === "\\") return "\\\\";
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

const byteUnits = ["B", "kB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];

// 位元組數以十進位單位與至少三位有效數字顯示，例如 168 B、1.23 kB、1 MB。
export function formatBytes(bytes: number): string {
  let exponent = bytes >= 1 ? Math.min(Math.floor(Math.log10(bytes) / 3), byteUnits.length - 1) : 0;
  let value = bytes / 1000 ** exponent;
  if (value < 1 && exponent > 0) {
    value *= 1000;
    exponent--;
  }
  value = Number(value.toPrecision(Math.max(3, Math.floor(value).toString().length)));
  if (value >= 1000 && exponent < byteUnits.length - 1) {
    value /= 1000;
    exponent++;
  }
  return `${value} ${byteUnits[exponent]}`;
}

export function displayJson(value: unknown): string {
  // 只跳脫 JSON 仍會原樣保留的控制字元，維持解析後的資料不變。
  return JSON.stringify(value, null, 2).replace(/[\x7f-\x9f\u2028\u2029\p{Bidi_Control}]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
