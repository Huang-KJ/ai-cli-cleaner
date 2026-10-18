export function displayText(value: string): string {
  return value.replace(/[\\\x00-\x1f\x7f-\x9f\u2028\u2029\p{Bidi_Control}]/gu, (character) => {
    if (character === "\\") return "\\\\";
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

export function displayJson(value: unknown): string {
  // 只跳脫 JSON 仍會原樣保留的控制字元，維持解析後的資料不變。
  return JSON.stringify(value, null, 2).replace(/[\x7f-\x9f\u2028\u2029\p{Bidi_Control}]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
