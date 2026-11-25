/** Client-side URL guard: treats empty strings (e.g. manual triggers) as absent. */
export function hasExternalUrl(url: string | undefined): url is string {
  return typeof url === 'string' && url.trim() !== ''
}
