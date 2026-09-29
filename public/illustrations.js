// A paragraph that only stands for an illustration, as written by extraction ("[图片]") or echoed by a translator.
// Shared by the reader and the EPUB exporter.
export const IMAGE_PARAGRAPH = /^[\[［【〔]\s*(图片|圖片|插图|插圖|挿絵|挿画|画像|イラスト|image|illustration)\s*([:：][^\]］】〕]*)?[\]］】〕]$/i;
export const isIllustrationText = (text) => {
  const parts = String(text || "").split(/\n\s*\n|\n/).map((t) => t.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((t) => IMAGE_PARAGRAPH.test(t));
};
