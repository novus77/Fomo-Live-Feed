/**
 * Fast, private language hint for the product's dominant English/Chinese
 * opinion flow. It intentionally refuses short or mixed input so ambiguous
 * text still falls through to Chrome's Language Detector.
 */
export function inferCommonOpinionLanguage(text: string): 'en' | 'zh' | undefined {
  const chineseCount = (text.match(/[\p{Script=Han}]/gu) ?? []).length;
  const latinCount = (text.match(/[A-Za-z]/g) ?? []).length;

  if (chineseCount >= 4 && chineseCount >= latinCount) {
    return 'zh';
  }

  if (latinCount >= 12 && latinCount >= chineseCount * 3) {
    return 'en';
  }

  return undefined;
}
