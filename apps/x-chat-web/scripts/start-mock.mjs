// Starts the adapter in Mock mode without shell-specific env syntax, so
// `npm run start:mock` behaves the same in PowerShell, cmd, and bash.
process.env.X_CHAT_API_MODE = "mock";
await import("../server.mjs");
