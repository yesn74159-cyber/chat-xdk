const DEFAULT_CHANNEL = "x-chat-local-cache-v1";

/**
 * Cross-tab notice for the local ciphertext cache. IndexedDB has no change
 * events, so a tab that writes announces it; a tab that hears another writer
 * must re-unlock before it saves again, otherwise it would overwrite the newer
 * document with its stale in-memory copy.
 */
export function createCacheSync(channelName = DEFAULT_CHANNEL) {
  let channel = null;
  if (typeof BroadcastChannel === "function") {
    try {
      channel = new BroadcastChannel(channelName);
    } catch {
      channel = null;
    }
  }
  return {
    supported: channel !== null,
    announce() {
      try {
        channel?.postMessage({ type: "cache-written" });
      } catch {
        // A closed channel must not break the save that already succeeded.
      }
    },
    onChange(callback) {
      if (!channel) return () => {};
      const listener = (event) => {
        if (event?.data?.type === "cache-written") callback();
      };
      channel.addEventListener("message", listener);
      return () => channel.removeEventListener("message", listener);
    },
    close() {
      try {
        channel?.close();
      } catch {
        // Closing an already-closed channel is harmless.
      }
    },
  };
}
