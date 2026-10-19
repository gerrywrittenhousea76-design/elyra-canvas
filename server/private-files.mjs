/** Shared by the API server and standalone Vite dev server. */
export function isPrivateResource(requestUrl = '/') {
  let path = requestUrl.split('?')[0];
  try {
    for (let depth = 0; depth < 4; depth++) {
      const decoded = decodeURIComponent(path);
      if (decoded === path) break;
      path = decoded;
    }
  } catch { return true; }
  if (/%[a-f0-9]{2}/i.test(path)) return true;
  path = path.replaceAll('\\', '/');
  return /(?:^|\/)(?:\.elyra-runtime|\.proofharness|\.env(?:\.[^/?#]*)?)(?:[/?#]|$)/i.test(path);
}
