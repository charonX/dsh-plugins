/**
 * Result types shared by the settings page and the Host face.
 *
 * They live apart from any component so the write path never depends on the
 * render tree, and so removing a surface cannot strand a type the Host face
 * still needs.
 *
 * @module dsh-model-studio/client/results
 */

/** What one compatibility save attempt answered. */
export type CompatSaveResult =
  | { readonly kind: 'saved' }
  | { readonly kind: 'cleared' }
  | { readonly kind: 'refused'; readonly message: string }

/** What one preset apply attempt answered. */
export type PresetApplyResult =
  | { readonly kind: 'written' }
  | { readonly kind: 'exists' }
  | { readonly kind: 'readonly' }
  | { readonly kind: 'refused'; readonly message: string }
