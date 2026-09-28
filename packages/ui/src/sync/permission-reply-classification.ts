/**
 * Permission-reply failures the card must not treat as a generic error.
 *
 * A 404 on `permission.reply` is ambiguous, and the two readings need opposite
 * answers:
 *
 *   * The server no longer holds the request. The step that raised it was
 *     interrupted (sending a message with a prompt open rejects the pending
 *     permission and aborts the step), or the service restarted — pending
 *     permissions are in-memory only. The card is a zombie: there is nothing
 *     left to approve, and "always" will never persist the pattern, so the same
 *     directory keeps asking.
 *   * The reply reached a per-directory instance that never owned the request
 *     while it stays pending in another one. The card is live and must stay up
 *     for a retry.
 *
 * Only the first is dead, so `respondToPermission` asks the server
 * (`fetchPermission`, whose 404 is the one server-confirmed "no longer
 * pending") before declaring it, and tags the error it rethrows. String
 * matching the message is not a contract — a reworded server error would
 * silently send the card back to swallowing the click, which is the bug this
 * module exists to kill: the shared response hook used to `console.error` every
 * failure, so the user clicked a dead prompt forever with no signal at all.
 */

const PERMISSION_ALREADY_RESOLVED_FLAG = '__openchamberPermissionAlreadyResolved';

/**
 * Mark an error as "the server confirmed this permission is gone". Returns the
 * same error so it can be thrown inline.
 */
export const markPermissionAlreadyResolved = <T extends Error>(error: T): T => {
  Object.defineProperty(error, PERMISSION_ALREADY_RESOLVED_FLAG, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return error;
};

/**
 * True when the server confirmed the request is no longer pending, so the
 * caller should retire the card and say so instead of reporting a failed send.
 */
export const isPermissionAlreadyResolvedError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  return (error as Record<string, unknown>)[PERMISSION_ALREADY_RESOLVED_FLAG] === true;
};
