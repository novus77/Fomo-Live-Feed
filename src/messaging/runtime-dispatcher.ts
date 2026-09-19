export type RuntimeSendResponse = (response: unknown) => void;

export type RuntimeRequestHandler<TSender = unknown> = (
  message: unknown,
  sender: TSender,
) => unknown;

/**
 * Adapts Promise-based internal handlers to Chrome's callback runtime API.
 * Returning literal true preserves the response channel on Chrome versions
 * that do not support Promise-returning onMessage listeners.
 */
export function createRuntimeMessageDispatcher<TSender = unknown>(
  handler: RuntimeRequestHandler<TSender>,
): (
  message: unknown,
  sender: TSender,
  sendResponse?: RuntimeSendResponse,
) => true | undefined {
  return (message, sender, sendResponse) => {
    let result: unknown;

    try {
      result = handler(message, sender);
    } catch {
      sendResponse?.({ ok: false, error: 'request-failed' });
      return true;
    }

    if (result === undefined) {
      return undefined;
    }

    Promise.resolve(result).then(
      (response) => sendResponse?.(response),
      () => sendResponse?.({ ok: false, error: 'request-failed' }),
    );
    return true;
  };
}
