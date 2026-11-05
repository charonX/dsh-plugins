/**
 * One failure type for every route: the HTTP status and machine code travel
 * together so the client never parses messages.
 *
 * @module dsh-immersive-translate/errors
 */

/** Failure reported to the browser as `{ error: { code, message } }`. */
export class TranslateError extends Error {
  /**
   * @param status - HTTP status the route answers with.
   * @param code - machine-readable code the client branches on.
   * @param message - operator-facing explanation; never contains translated text.
   */
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'TranslateError'
  }
}

/**
 * Convert an unknown throw into a failure the route can answer.
 * @param error - whatever a dependency rejected with.
 * @returns the original failure, or an internal one wrapping it.
 */
export function asTranslateError(error: unknown): TranslateError {
  if (error instanceof TranslateError) return error
  return new TranslateError(500, 'INTERNAL', error instanceof Error ? error.message : String(error))
}
