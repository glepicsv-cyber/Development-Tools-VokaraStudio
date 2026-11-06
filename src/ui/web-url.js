// Đổi nội dung ô địa chỉ thành URL: link thì mở, còn lại coi là tên bài để tìm.

const YOUTUBE_SEARCH = 'https://www.youtube.com/results?search_query=';
const LOOKS_LIKE_HOST = /^(?:localhost|[\w-]+(?:\.[\w-]+)+)(?::\d+)?(?:[/?#]\S*)?$/i;

export function normalizeWebInput(text) {
  const value = String(text ?? '').trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) {
    try {
      return new URL(value).href;
    } catch {
      return null;
    }
  }
  if (LOOKS_LIKE_HOST.test(value)) return `https://${value}`;
  return YOUTUBE_SEARCH + encodeURIComponent(value);
}
